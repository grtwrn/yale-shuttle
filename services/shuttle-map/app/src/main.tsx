import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import TransitMap from "./TransitMap";
import MinimapReview from "./MinimapReview";

const params = new URLSearchParams(window.location.search);
const Page = params.get("review") === "minimap" ? MinimapReview : TransitMap;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Page />
  </StrictMode>
);
