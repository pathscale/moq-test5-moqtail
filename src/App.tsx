import { Router, Route } from "@solidjs/router";

import { IndexPage } from "./pages/IndexPage";
import { JsApiPage } from "./pages/JsApiPage";
import { SolidOverlayPage } from "./pages/SolidOverlayPage";
import { WebComponentsPage } from "./pages/WebComponentsPage";

export default function App() {
  return (
    <Router>
      <Route path="/" component={IndexPage} />
      <Route path="/js/:streamName?" component={JsApiPage} />
      <Route path="/wc/:streamName?" component={WebComponentsPage} />
      <Route path="/overlay/:streamName?" component={SolidOverlayPage} />
    </Router>
  );
}
