"""Explicit host composition; no import-time SDK, network, parser or process effects."""

def create_handlers(host_context):
    from .handlers import create_handlers as build
    return build(host_context)


def load_configuration(selection, artifacts, contracts):
    from .configuration import load_configuration as load
    return load(selection, artifacts, contracts)


def create_host_admission(config, clock, owner_fence):
    from .admission import create_host_admission as create
    return create(config, clock, owner_fence)


__all__ = ["create_handlers", "create_host_admission", "load_configuration"]
