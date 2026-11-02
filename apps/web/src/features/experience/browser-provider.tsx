"use client";

import { useState, type ReactNode } from "react";
import { createApiClient } from "@darkfactory/api/client";
import { VertexReadError } from "../../components/research/vertex-client.ts";
import { createExperienceServices } from "./transport.ts";
import { ExperienceProvider } from "./shared.tsx";
import type {
  ExperienceResearchChatPort,
  ExperienceServices,
} from "./ports.ts";

// Only the transport instance is retained. No account selection, artifact,
// credential, prompt or response is cached here. Constructing and SSR-rendering
// this wrapper cannot access window, create an API client, or issue a request.
export const createBrowserExperienceServices = (): ExperienceServices => {
  let services: ExperienceServices | undefined;
  const current = (signal: AbortSignal): ExperienceServices => {
    if (signal.aborted) throw new VertexReadError("suspended");
    if (typeof window === "undefined") throw new VertexReadError("unavailable");
    if (
      window.location.protocol !== "https:" &&
      window.location.protocol !== "http:"
    )
      throw new VertexReadError("unavailable");
    services ??= createExperienceServices(
      createApiClient({
        baseUrl: window.location.origin,
        // Forward the actual Request (body, headers and signal), plus any supplied
        // init, overriding only browser cache/credential policy. Never retain bytes.
        fetch: (request: Request, init?: RequestInit) =>
          fetch(request, {
            ...init,
            credentials: "same-origin",
            cache: "no-store",
          }),
      })
    );
    return services;
  };
  const currentChat = (signal: AbortSignal): ExperienceResearchChatPort => {
    const port = current(signal).researchChat;
    if (port === null || port === undefined)
      throw new VertexReadError("unavailable");
    return port;
  };
  return {
    researchChat: {
      roster: async (input, signal) =>
        currentChat(signal).roster(input, signal),
      listThreads: async (input, signal) =>
        currentChat(signal).listThreads(input, signal),
      createThread: async (input, signal) =>
        currentChat(signal).createThread(input, signal),
      readThread: async (input, signal) =>
        currentChat(signal).readThread(input, signal),
      listMessages: async (input, signal) =>
        currentChat(signal).listMessages(input, signal),
      readTranscriptPage: async (input, signal) =>
        currentChat(signal).readTranscriptPage(input, signal),
      sendMessage: async (input, signal) =>
        currentChat(signal).sendMessage(input, signal),
      prepareResponse: async (input, signal) =>
        currentChat(signal).prepareResponse(input, signal),
      approveAndRequestResponse: async (input, signal) =>
        currentChat(signal).approveAndRequestResponse(input, signal),
      prepareNativeEvidence: async (input, signal) =>
        currentChat(signal).prepareNativeEvidence(input, signal),
      approveAndRequestNativeEvidence: async (input, signal) =>
        currentChat(signal).approveAndRequestNativeEvidence(input, signal),
      prepareDebateStep: async (input, signal) =>
        currentChat(signal).prepareDebateStep(input, signal),
      approveAndRequestDebateStep: async (input, signal) =>
        currentChat(signal).approveAndRequestDebateStep(input, signal),
      readDebateRun: async (input, signal) =>
        currentChat(signal).readDebateRun(input, signal),
      readResponse: async (input, signal) =>
        currentChat(signal).readResponse(input, signal),
      appendResponse: async (input, signal) =>
        currentChat(signal).appendResponse(input, signal),
      readResponseContent: async (input, signal) =>
        currentChat(signal).readResponseContent(input, signal),
    },
    reads: {
      scopes: async (input, signal) =>
        current(signal).reads.scopes(input, signal),
      portfolio: async (input, signal) =>
        current(signal).reads.portfolio(input, signal),
      continuity: async (input, signal) =>
        current(signal).reads.continuity(input, signal),
      inbox: async (input, signal) =>
        current(signal).reads.inbox(input, signal),
      strategies: async (input, signal) =>
        current(signal).reads.strategies(input, signal),
      dossier: async (input, signal) =>
        current(signal).reads.dossier(input, signal),
      agents: async (input, signal) =>
        current(signal).reads.agents(input, signal),
      agent: async (input, signal) =>
        current(signal).reads.agent(input, signal),
      audit: async (input, signal) =>
        current(signal).reads.audit(input, signal),
      gateways: async (input, signal) =>
        current(signal).reads.gateways(input, signal),
      gateway: async (input, signal) =>
        current(signal).reads.gateway(input, signal),
    },
    reviews: {
      decide: async (input, signal) => {
        const port = current(signal).reviews;
        if (port === null) throw new VertexReadError("unavailable");
        return await port.decide(input, signal);
      },
    },
    jobs: {
      proposeResearch: async (input, signal) => {
        const port = current(signal).jobs;
        if (port === null) throw new VertexReadError("unavailable");
        return await port.proposeResearch(input, signal);
      },
      proposeSimulation: async (input, signal) => {
        const port = current(signal).jobs;
        if (port === null) throw new VertexReadError("unavailable");
        return await port.proposeSimulation(input, signal);
      },
    },
  };
};

// Main mounts beneath the existing ResearchReadScopeProvider. This provider adds
// no authentication or session lifetime. Scope discovery and the default scope
// live in ScopeChooser (server-authorized vertex.experience.scopes).
export const BrowserExperienceProvider = ({
  children,
}: {
  readonly children: ReactNode;
}) => {
  const [services] = useState(createBrowserExperienceServices);
  return (
    <ExperienceProvider services={services}>{children}</ExperienceProvider>
  );
};
