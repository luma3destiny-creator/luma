using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [(name = "test", worker = (
    modules = [
      (name = "worker.mjs", esModule = embed "worker.mjs"),
      (name = "sms.mjs", esModule = embed "../../functions/lib/sms.mjs")
    ],
    compatibilityDate = "2024-01-01"
  ))],
  sockets = [(name = "http", address = "127.0.0.1:8899", http = (), service = "test")]
);
