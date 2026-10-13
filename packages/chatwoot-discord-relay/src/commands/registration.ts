// One registration payload and bulk overwrite for the Worker and the local setup script.

import {
  type RESTPutAPIApplicationGuildCommandsJSONBody,
  type RESTPutAPIApplicationGuildCommandsResult,
  Routes,
} from "discord-api-types/v10";
import type { DiscordRest } from "../discord/rest.ts";
import { COMMANDS } from "./definitions.ts";

export function commandRegistrationPayload(): RESTPutAPIApplicationGuildCommandsJSONBody {
  return COMMANDS;
}

/** Commands and their destinations; account order and shared forums do not change registration. */
export async function commandRegistrationHash(
  commands: RESTPutAPIApplicationGuildCommandsJSONBody,
  forumChannelIds: readonly string[],
): Promise<string> {
  const forums = [...new Set(forumChannelIds)].sort();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ commands, forums })));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function registerGuildCommands(
  rest: DiscordRest,
  applicationId: string,
  guildId: string,
  payload = commandRegistrationPayload(),
): Promise<RESTPutAPIApplicationGuildCommandsResult> {
  return rest.put<RESTPutAPIApplicationGuildCommandsResult, RESTPutAPIApplicationGuildCommandsJSONBody>(
    Routes.applicationGuildCommands(applicationId, guildId),
    { body: payload },
  );
}
