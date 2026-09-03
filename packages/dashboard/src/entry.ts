import { Runtime } from "foldkit";

import { DashboardDemoLayer } from "./demo/layer.js";
import { Message, init, update, view } from "./main.js";
import { Model } from "./model.js";
import "./styles.css";

const application = Runtime.makeApplication({
  Model,
  container: document.getElementById("root"),
  init,
  update,
  view,
  resources: DashboardDemoLayer,
  devTools: { Message },
});

Runtime.run(application);
