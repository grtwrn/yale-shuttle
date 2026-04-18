import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import TransitMap from "./TransitMap";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TransitMap />
  </StrictMode>
);
