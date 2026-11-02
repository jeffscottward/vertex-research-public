"""Source-only regressions; execution deferred by the buildout sequence.

No real sockets, credentials, authority bundle generation or provider calls.
The recording authority is deliberately a transport unit double, not a validator
available to production composition.
"""
import asyncio
import base64
from hashlib import sha256
import json
import ssl
import unittest
from unittest.mock import patch

from vertex_control import ClientConfig, ControlClient, ControlError, LoopBridge, SameORPCJSON, decode_content


FENCE = {"accountAlias": "research-account", "environment": "research", "jobId": "job-1",
         "leaseId": "lease-1", "leaseEpoch": "1"}
RESULT = {"status": "accepted", "jobId": "job-1", "state": "running", "lease": None,
          "outputArtifactIds": [], "reason": None}


class RecordingAuthority:
    def __init__(self):
        self.calls = []
        self.reject = None

    def encode(self, value):
        return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()

    def digest(self, value):
        return sha256(self.encode(value)).hexdigest()

    def epoch_ns(self, _):
        return 1

    def validate(self, name, payload, schema_version="1.0.0"):
        self.calls.append((name, payload, schema_version))
        if name == self.reject:
            raise ValueError("private diagnostic must not escape")
        return True


class Response:
    status = 200

    def __init__(self, content=None, *, status=200, headers=None):
        self.status = status
        self.content = content if content is not None else SameORPCJSON().encode(RESULT)
        self.headers = headers if headers is not None else [
            ("Content-Type", "application/json"), ("Content-Length", str(len(self.content)))
        ]
        self.reads = 0

    def getheaders(self):
        return self.headers

    def read1(self, count):
        self.reads += 1
        value, self.content = self.content[:count], self.content[count:]
        return value


class Connection:
    made = []
    response = None
    connect_error = None
    response_error = None

    def __init__(self, host, port, *, timeout, context):
        self.host, self.port, self.timeout, self.context = host, port, timeout, context
        self.requests, self.connected, self.closed = [], False, False
        self.sock = self
        type(self).made.append(self)

    def settimeout(self, timeout):
        if timeout <= 0:
            raise AssertionError("positive remaining time required")

    def connect(self):
        if type(self).connect_error:
            raise type(self).connect_error
        self.connected = True

    def request(self, method, path, *, body, headers):
        if not self.connected:
            raise AssertionError("credentials sent before TLS")
        self.requests.append((method, path, body, headers))

    def getresponse(self):
        if type(self).response_error:
            raise type(self).response_error
        return type(self).response

    def close(self):
        self.closed = True


class TransportTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        Connection.made = []
        Connection.response = Response()
        Connection.connect_error = Connection.response_error = None
        self.authority = RecordingAuthority()
        self.references = []
        def resolver(reference):
            self.references.append(reference)
            return "test-only-token"
        self.client = ControlClient(ClientConfig(origin="https://control.example.test", credential_ref="test/ref"),
                                    resolver, self.authority)
        self.patcher = patch("vertex_control.client.http.client.HTTPSConnection", Connection)
        self.patcher.start()

    async def asyncTearDown(self):
        await self.client.aclose()
        self.patcher.stop()

    async def test_fixed_route_orpc_origin_and_authoritative_boundaries(self):
        payload = {**FENCE, "runId": "run-1", "requestSha256": "a" * 64}
        self.assertEqual(await self.client.admit_run(**payload), RESULT)
        connection = Connection.made[0]
        self.assertTrue(connection.context.check_hostname)
        self.assertEqual(connection.context.verify_mode, ssl.CERT_REQUIRED)
        self.assertEqual(connection.auto_open, 0)
        method, path, body, headers = connection.requests[0]
        self.assertEqual((method, path), ("POST", "/api/orpc/vertexWorker/admitRun"))
        self.assertEqual(json.loads(body), {"json": payload})
        self.assertEqual(headers["Origin"], "https://control.example.test")
        self.assertNotIn("sec-fetch-site", {key.lower() for key in headers})
        self.assertEqual(self.references, ["test/ref"])
        self.assertEqual([row[0] for row in self.authority.calls], ["WorkerAdmitRunInput", "WorkerResult"])
        self.assertTrue(connection.closed)

    async def test_invalid_request_never_resolves_credentials_or_connects(self):
        self.authority.reject = "WorkerAdmitRunInput"
        with self.assertRaisesRegex(ControlError, "request-contract-rejected") as caught:
            await self.client.admit_run(**FENCE)
        self.assertEqual(caught.exception.effect, "not-sent")
        self.assertEqual(self.references, [])
        self.assertEqual(Connection.made, [])
        self.assertNotIn("private diagnostic", str(caught.exception))

    async def test_tls_failure_is_not_sent_and_does_not_retry(self):
        Connection.connect_error = ssl.SSLCertVerificationError("private host diagnostic")
        with self.assertRaises(ControlError) as caught:
            await self.client.admit_run(**FENCE)
        self.assertEqual(caught.exception.effect, "not-sent")
        self.assertEqual(len(Connection.made), 1)
        self.assertEqual(Connection.made[0].requests, [])
        self.assertNotIn("private host", str(caught.exception))

    async def test_redirect_is_never_followed_and_mutation_is_unknown(self):
        Connection.response = Response(status=307, headers=[("Location", "https://attacker.invalid/secret")])
        with self.assertRaisesRegex(ControlError, "redirect-rejected") as caught:
            await self.client.admit_run(**FENCE)
        self.assertEqual(caught.exception.effect, "unknown")
        self.assertFalse(caught.exception.retryable)
        self.assertEqual(len(Connection.made), 1)
        self.assertEqual(Connection.response.reads, 0)
        self.assertNotIn("attacker", str(caught.exception))

    async def test_lost_response_has_unknown_effect_and_no_retry(self):
        Connection.response_error = OSError("private socket detail")
        with self.assertRaises(ControlError) as caught:
            await self.client.publish_artifact(**FENCE)
        self.assertEqual(caught.exception.effect, "unknown")
        self.assertEqual(len(Connection.made), 1)
        self.assertEqual(len(Connection.made[0].requests), 1)

    async def test_huge_declared_response_rejected_before_buffering(self):
        Connection.response = Response(headers=[("Content-Type", "application/json"), ("Content-Length", "2097153")])
        with self.assertRaisesRegex(ControlError, "response-too-large"):
            await self.client.admit_run(**FENCE)
        self.assertEqual(Connection.response.reads, 0)

    async def test_huge_chunked_response_is_bounded(self):
        Connection.response = Response(b"x" * 2_097_153,
            headers=[("Content-Type", "application/json"), ("Transfer-Encoding", "chunked")])
        with self.assertRaisesRegex(ControlError, "response-too-large"):
            await self.client.admit_run(**FENCE)
        self.assertLessEqual(Connection.response.reads, 33)

    async def test_malformed_duplicate_nonfinite_and_bare_envelopes_rejected(self):
        for content in (b'{"json":{},"json":{}}', b'{"json":{"x":NaN}}', b'{}', b'{"json":{},"meta":[]}', b'not-json'):
            with self.subTest(content=content):
                Connection.response = Response(content)
                with self.assertRaisesRegex(ControlError, "response-contract-rejected") as caught:
                    await self.client.admit_run(**FENCE)
                self.assertEqual(caught.exception.effect, "unknown")

    async def test_invalid_response_schema_is_not_success(self):
        self.authority.reject = "WorkerResult"
        with self.assertRaisesRegex(ControlError, "response-contract-rejected"):
            await self.client.admit_run(**FENCE)

    async def test_read_failure_does_not_claim_mutating_effect(self):
        Connection.response_error = OSError("private detail")
        with self.assertRaises(ControlError) as caught:
            await self.client.read_artifact(**FENCE)
        self.assertEqual(caught.exception.effect, "none")

    async def test_header_injection_credential_is_never_sent(self):
        self.client._resolver = lambda _: "token\r\nX-Secret: private"
        with self.assertRaisesRegex(ControlError, "credential-unavailable"):
            await self.client.admit_run(**FENCE)
        self.assertEqual(Connection.made, [])

    async def test_nested_event_loop_bridge_fails_without_creating_coroutine(self):
        bridge = LoopBridge(asyncio.get_running_loop())
        with self.assertRaisesRegex(ControlError, "synchronous-port-called-on-event-loop"):
            bridge.run(lambda: self.fail("must not invoke coroutine factory"))

    async def test_closed_client_has_no_network_effect(self):
        await self.client.aclose()
        with self.assertRaisesRegex(ControlError, "client-closed"):
            await self.client.admit_run(**FENCE)
        self.assertEqual(Connection.made, [])


class ConfigurationTests(unittest.TestCase):
    def test_explicit_origin_only(self):
        for origin in ("http://control.test", "https://user:pass@control.test", "https://control.test/path",
                       "https://control.test?x=1", "https://control.test#x", "https://control.test\n",
                       "https://control.test/", "https://control.test:0", "https://control.test\\evil"):
            with self.subTest(origin=origin), self.assertRaises(ControlError):
                ClientConfig(origin=origin, credential_ref="test/ref")

    def test_explicit_positive_budgets(self):
        for values in ({"timeout_seconds": True}, {"timeout_seconds": float("inf")},
                       {"timeout_seconds": 0}, {"max_request_bytes": 2_097_153}, {"max_response_bytes": False}):
            with self.subTest(values=values), self.assertRaises(ControlError):
                ClientConfig(origin="https://control.test", credential_ref="test/ref", **values)

    def test_strict_base64_raw_hash_and_padding(self):
        raw = b"a"
        digest = sha256(raw).hexdigest()
        self.assertEqual(decode_content(base64.b64encode(raw).decode(), digest), raw)
        for value in ("YQ==junk", "YQ===", "YR==", "YQ==\n", "Y Q=="):
            with self.subTest(value=value), self.assertRaises(ControlError):
                decode_content(value, digest)
        with self.assertRaises(ControlError):
            decode_content("YQ==", "0" * 64)
        huge = b"x" * 1_048_577
        with self.assertRaises(ControlError):
            decode_content(base64.b64encode(huge).decode(), sha256(huge).hexdigest())
