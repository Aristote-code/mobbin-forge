import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
const iframe = document.getElementById("gallery") as HTMLIFrameElement;
const token = document.querySelector<HTMLMetaElement>('meta[name="preview-token"]')!.content;
async function rpc(params: unknown) {
  const response = await fetch("/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Preview-Token": token },
    body: JSON.stringify(params),
  });
  if (!response.ok) throw Error("Preview request failed");
  return response.json();
}
const bridge = new AppBridge(
  null,
  { name: "Mobbin Forge local preview", version: "1" },
  { openLinks: {}, serverTools: {}, logging: {} },
  {
    hostContext: {
      theme: "light",
      displayMode: "inline",
      availableDisplayModes: ["inline"],
      containerDimensions: { width: 1000, maxHeight: 1600 },
    },
  },
);
bridge.oncalltool = rpc;
bridge.onopenlink = async ({ url }) => {
  if (new URL(url).hostname === "bytescale.mobbin.com") window.open(url, "_blank", "noopener");
  return {};
};
bridge.oninitialized = async () => {
  try {
    const { args, result, cached } = await (await fetch("/initial")).json();
    await bridge.sendToolInput({ arguments: args });
    await bridge.sendToolResult(result);
    document.getElementById("status")!.textContent = result.isError
      ? "Mobbin sign-in required. Re-authenticate locally and restart this preview."
      : cached
        ? "Connected to local MCP · Cached Duolingo references from November 12"
        : "Connected to local MCP · Live Duolingo screens";
  } catch {
    document.getElementById("status")!.textContent = "Could not load screens. Check the terminal.";
  }
};
bridge.onsizechange = ({ height }) => {
  iframe.style.height = `${Math.max(650, Math.min(height, 1600))}px`;
};
await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
iframe.src = "/gallery";
