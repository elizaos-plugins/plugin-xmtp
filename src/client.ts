import {
  DecodedMessage,
  Client as XmtpClient,
  type XmtpEnv,
  type Conversation,
} from "@xmtp/node-sdk";
import { createEOASigner, createSCWSigner, SignerType } from "./helper.ts";

import {
  composeContext,
  Content,
  elizaLogger,
  Memory,
  ModelClass,
  stringToUuid,
  messageCompletionFooter,
  generateMessageResponse,
  Client,
  IAgentRuntime,
} from "@elizaos/core";
import { Hex } from "viem";

let client: XmtpClient = null;
let elizaRuntime: IAgentRuntime = null;

export const messageHandlerTemplate =
  // {{goals}}
  `# Action Examples
{{actionExamples}}
(Action examples are for reference only. Do not use the information from them in your response.)

# Knowledge
{{knowledge}}

# Task: Generate dialog and actions for the character {{agentName}}.
About {{agentName}}:
{{bio}}
{{lore}}

{{providers}}

{{attachments}}

# Capabilities
Note that {{agentName}} is capable of reading/seeing/hearing various forms of media, including images, videos, audio, plaintext and PDFs. Recent attachments have been included above under the "Attachments" section.

{{messageDirections}}

{{recentMessages}}

{{actions}}

# Instructions: Write the next message for {{agentName}}.
` + messageCompletionFooter;

export const XmtpClientInterface: Client = {
  start: async (runtime: IAgentRuntime) => {
    if (!client) {
      elizaRuntime = runtime;

      const walletKey = process.env.WALLET_KEY as Hex;
      const signerType = process.env.XMTP_SIGNER_TYPE as SignerType;
      const chainId = process.env.XMTP_SCW_CHAIN_ID;
      const env = process.env.XMTP_ENV as XmtpEnv || "production";

      if (!walletKey) {
        elizaLogger.error(
          "WALLET_KEY environment variable is not set. Please set it to your wallet private key."
        );
        return;
      }

      if (signerType !== "EOA" && signerType !== "SCW") {
        elizaLogger.error(
          "SIGNER_TYPE environment variable is set to an invalid value. Please set it to 'EOA' or 'SCW'."
        );
        return;
      }

      if (signerType === "SCW" && !chainId) {
        elizaLogger.error(
          "CHAIN_ID environment variable is not set. Please set it to your chain ID."
        );
        return;
      }

      const signer = signerType === 'SCW' 
        ? createSCWSigner(walletKey, BigInt(chainId)) 
        : createEOASigner(walletKey);

      elizaLogger.success(`Creating client on the '${env}' network...`);
      client = await XmtpClient.create(signer, {
        env
      });

      elizaLogger.success("Syncing conversations...");
      await client.conversations.sync();

      elizaLogger.success(
        `Agent initialized on ${client.accountIdentifier.identifier}\nSend a message on http://xmtp.chat/dm/${client.accountIdentifier.identifier}?env=${env}`
      );

      elizaLogger.success("Waiting for messages...");
      client.conversations.streamAllMessages(async (err, message) => {
        if (err) {
          elizaLogger.error("Error streaming messages", err);
          return;
        }
        
        if (
          message?.senderInboxId.toLowerCase() ===
            client.inboxId.toLowerCase() ||
          message?.contentType?.typeId !== "text"
        ) {
          return;
        }

        // Ignore own messages
        if (message.senderInboxId === client.inboxId) {
          return
        }

        elizaLogger.success(
          `Received message: ${message.content as string} by ${
            message.senderInboxId
          }`
        );

        const conversation = await client.conversations.getConversationById(
          message.conversationId
        );

        if (!conversation) {
          console.log("Unable to find conversation, skipping");
          return;
        }

        elizaLogger.success(`Sending "gm" response...`);

        await processMessage(message, conversation);

        elizaLogger.success("Waiting for messages...");
      });

      elizaLogger.success("✅ XMTP client started");

      return client;
    }
  },
  stop: async (_runtime: IAgentRuntime) => {
    elizaLogger.warn("XMTP client does not support stopping yet");
  },
};

const processMessage = async (
  message: DecodedMessage<any>,
  conversation: Conversation
) => {
  try {
    const text = message?.content ?? "";
    const messageId = stringToUuid(message.id as string);
    const userId = stringToUuid(message.senderInboxId as string);
    const roomId = stringToUuid(message.conversationId as string);
    await elizaRuntime.ensureConnection(
      userId,
      roomId,
      message.senderInboxId,
      message.senderInboxId,
      "xmtp"
    );

    const content: Content = {
      text,
      source: "xmtp",
      inReplyTo: undefined,
    };

    const userMessage = {
      content,
      userId,
      roomId,
      agentId: elizaRuntime.agentId,
    };

    const memory: Memory = {
      id: messageId,
      agentId: elizaRuntime.agentId,
      userId,
      roomId,
      content,
      createdAt: Date.now(),
    };

    await elizaRuntime.messageManager.createMemory(memory);

    const state = await elizaRuntime.composeState(userMessage, {
      agentName: elizaRuntime.character.name,
    });

    const context = composeContext({
      state,
      template: messageHandlerTemplate,
    });

    const response = await generateMessageResponse({
      runtime: elizaRuntime,
      context,
      modelClass: ModelClass.LARGE,
    });
    const _newMessage = [
      {
        text: response?.text,
        source: "xmtp",
        inReplyTo: messageId,
      },
    ];
    // save response to memory
    const responseMessage = {
      ...userMessage,
      userId: elizaRuntime.agentId,
      content: response,
    };

    await elizaRuntime.messageManager.createMemory(responseMessage);

    if (!response) {
      elizaLogger.error("No response from generateMessageResponse");
      return;
    }

    await elizaRuntime.evaluate(memory, state);

    const _result = await elizaRuntime.processActions(
      memory,
      [responseMessage],
      state,
      async (newMessages) => {
        if (newMessages.text) {
          _newMessage.push({
            text: newMessages.text,
            source: "xmtp",
            inReplyTo: undefined,
          });
        }
        return [memory];
      }
    );
    for (const newMsg of _newMessage) {
      await conversation?.send(newMsg.text);
    }
  } catch (error) {
    elizaLogger.error("Error in onMessage", error);
  }
};

export default XmtpClientInterface;
