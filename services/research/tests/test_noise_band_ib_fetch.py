"""noise_band_ib_fetch.py: the CLIENT file that keeps one volume unit per output folder.

The real ibapi package is not installed in CI, so the four ibapi modules the script imports are
stubbed in sys.modules before the import. No gateway, no network.
"""
from __future__ import annotations

import importlib
import sys
import types

import pytest

MODULE = "strategies.noise_band_ib_fetch"


class _Stub:
    def __init__(self, *args, **kwargs) -> None:
        pass


@pytest.fixture
def fetch(monkeypatch):
    ibapi = types.ModuleType("ibapi")
    ibapi.get_version_string = lambda: "10.30.1"
    client = types.ModuleType("ibapi.client")
    client.EClient = type("EClient", (_Stub,), {"connect": _refuse_connect})
    contract = types.ModuleType("ibapi.contract")
    contract.Contract = type("Contract", (_Stub,), {})
    wrapper = types.ModuleType("ibapi.wrapper")
    wrapper.EWrapper = type("EWrapper", (_Stub,), {})
    ibapi.client, ibapi.contract, ibapi.wrapper = client, contract, wrapper
    for name, module in (("ibapi", ibapi), ("ibapi.client", client), ("ibapi.contract", contract),
                         ("ibapi.wrapper", wrapper)):
        monkeypatch.setitem(sys.modules, name, module)
    monkeypatch.delitem(sys.modules, MODULE, raising=False)
    module = importlib.import_module(MODULE)
    yield module
    sys.modules.pop(MODULE, None)


def _refuse_connect(self, *args, **kwargs):
    raise AssertionError("the gateway must not be asked")


def test_client_name_is_the_ibapi_version(fetch):
    assert fetch.client_name() == "ibapi 10.30.1"


def test_new_folder_gets_a_client_file(fetch, tmp_path):
    folder = tmp_path / "SPY"
    assert fetch.claim_folder(str(folder), "ibapi 10.30.1") is None
    assert (folder / "CLIENT").read_text() == "ibapi 10.30.1\n"


def test_existing_empty_folder_without_client_file_is_claimed(fetch, tmp_path):
    assert fetch.claim_folder(str(tmp_path), "ibapi 10.30.1") is None
    assert (tmp_path / "CLIENT").read_text() == "ibapi 10.30.1\n"


def test_folder_of_the_same_client_is_extended(fetch, tmp_path):
    (tmp_path / "CLIENT").write_text("ibapi 10.30.1\n")
    (tmp_path / "2026-10.csv").write_text("1,1,1,1,1,100\n")
    assert fetch.claim_folder(str(tmp_path), "ibapi 10.30.1") is None
    assert (tmp_path / "CLIENT").read_text() == "ibapi 10.30.1\n"


def test_folder_of_another_client_is_refused(fetch, tmp_path):
    (tmp_path / "CLIENT").write_text("ibapi 9.81.1\n")
    problem = fetch.claim_folder(str(tmp_path), "ibapi 10.30.1")
    assert problem is not None
    assert "ibapi 9.81.1" in problem and "ibapi 10.30.1" in problem and "new --out folder" in problem
    assert (tmp_path / "CLIENT").read_text() == "ibapi 9.81.1\n"


def test_empty_client_file_is_refused(fetch, tmp_path):
    (tmp_path / "CLIENT").write_text("")
    assert fetch.claim_folder(str(tmp_path), "ibapi 10.30.1") is not None


def test_folder_with_bars_but_no_client_file_is_refused(fetch, tmp_path):
    (tmp_path / "2026-10.csv").write_text("1,1,1,1,1,40\n")
    problem = fetch.claim_folder(str(tmp_path), "ibapi 10.30.1")
    assert problem is not None and "no CLIENT file" in problem
    assert not (tmp_path / "CLIENT").exists()


def test_main_stops_before_the_gateway_on_a_refused_folder(fetch, tmp_path, monkeypatch, capsys):
    (tmp_path / "QQQ").mkdir()
    (tmp_path / "QQQ" / "2026-10.csv").write_text("1,1,1,1,1,40\n")
    monkeypatch.setattr(sys, "argv", ["noise_band_ib_fetch.py", "--gateway", "127.0.0.1 4001",
                                      "--out", str(tmp_path), "--end", "2026-11", "SPY", "QQQ"])
    assert fetch.main() == fetch.EXIT_CLIENT_MISMATCH == 5
    err = capsys.readouterr().err
    assert err.startswith("QQQ: refused:") and "no CLIENT file" in err
