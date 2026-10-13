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
