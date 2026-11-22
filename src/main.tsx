import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { LoginGate } from "./components/LoginGate";
import { UpdateBanner } from "./components/UpdateBanner";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <LoginGate>
      <App />
    </LoginGate>
    <UpdateBanner />
  </React.StrictMode>,
);
