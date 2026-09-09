// Node workers start in JavaScript; register the installed tsx loader explicitly.
import { register } from "tsx/esm/api";
register();
await import("./standingForecast.worker.ts");
