/**
 * Compatibility bridge for restricted interactive-subagents.
 *
 * The pi-web-access package is loaded normally from the global package list.
 * interactive-subagents launches restricted children with --no-extensions and
 * resolves the `web_search` tool through this conventional path, so expose the
 * package's bundled extension there as well. The parent process skips this
 * bridge to avoid registering the same tools twice.
 */
import webAccessExtension from "../../npm/node_modules/pi-web-access/dist/index.js";

export default function webSearchSubagentExtension(pi: any): void {
  // Only restricted children need this bridge. Unrestricted children and the
  // parent already discover pi-web-access normally; loading it twice would
  // make Pi reject the duplicate web_search registration.
  if (!process.env.PI_SUBAGENT_SESSION || !process.argv.includes("--no-extensions")) return;
  webAccessExtension(pi);
}
