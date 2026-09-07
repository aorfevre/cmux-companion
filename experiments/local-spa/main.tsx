import { createRoot } from "react-dom/client";
import Home from "../../app/page";
import "../../app/globals.css";
import "../../app/features.css";
import "../../app/highlight.css";
import "../../app/context-banner.css";

createRoot(document.getElementById("root")!).render(<Home />);
