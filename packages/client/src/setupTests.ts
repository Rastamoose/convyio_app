import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// RTL only auto-registers cleanup when test globals are on; wire it up so
// each test starts from an empty document.
afterEach(cleanup);
