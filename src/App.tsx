import { Router, Route } from "@solidjs/router";
import { Test5 } from "./pages/Test5";

export default function App() {
  return (
    <Router>
      <Route path="/" component={Test5} />
    </Router>
  );
}
