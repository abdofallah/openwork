import { openworkYourConnectionsUrl } from "../mcp/connection-navigation.js"
import { proactiveHomeSection } from "../workbot-proactive/interactions.js"
import type { SlackCall } from "./protocol.js"
import type { InstallationRow } from "./repository.js"

/** The Slack app's Home tab: the assistant's own intro, then Heads-ups where the member gets them. */
export async function publishSlackHome(slack: SlackCall, installation: InstallationRow, slackUserId: string) {
  // The intro never waits on, or fails because of, the Heads-ups section.
  const headsUps = await proactiveHomeSection(installation, slackUserId).catch(() => [])
  await slack("views.publish", {
    user_id: slackUserId,
    view: {
      type: "home",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Your own OpenWork assistant. Connect your Slack account, then mention @openwork or send a message here.",
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: "connect_openwork",
              text: { type: "plain_text", text: "Connect OpenWork" },
              url: openworkYourConnectionsUrl(installation.connectionId),
            },
          ],
        },
        ...headsUps,
      ],
    },
  })
}
