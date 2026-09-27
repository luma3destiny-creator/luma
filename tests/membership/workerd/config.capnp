using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "test", worker = (
    modules = [(name = "worker.mjs", esModule = embed "../../../outputs/membership-worker.mjs")],
    compatibilityDate = "2024-01-01"
  ))],
  sockets = [(name = "http", address = "127.0.0.1:8901", http = (), service = "test")]
);
