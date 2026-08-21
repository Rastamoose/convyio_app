import { projectResponse } from "./server/project-response";
import { projectOwner } from "./web/project-card";
import { mobileProjectOwner } from "./mobile/project-client";

const response = projectResponse({ id: "project-1", ownerName: "Maya" }) as {
  id: string;
  owner?: string;
  owner_name: string;
};

let ok = true;
if (response.owner !== "Maya") {
  console.error(`new contract missing owner: ${JSON.stringify(response)}`);
  ok = false;
}
if (response.owner_name !== "Maya") {
  console.error(`legacy contract changed: ${JSON.stringify(response)}`);
  ok = false;
}
if (projectOwner(response) !== "Maya") {
  console.error("web client could not read owner");
  ok = false;
}
if (mobileProjectOwner(response) !== "Maya") {
  console.error("mobile client could not read owner_name");
  ok = false;
}
if (!ok) process.exit(1);
console.log("PASS owner=Maya owner_name=Maya web=Maya mobile=Maya");
