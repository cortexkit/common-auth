// A local "AI SDK provider package". The host accepts a provider package of the
// form `aisdk:file:///…/sdk-factory.mjs`: its built-in dynamic provider plugin
// imports the file and calls the first export whose name starts with `create`
// with the provider options it prepared (including the host's own `fetch`).
// This factory builds an @ai-sdk/openai instance whose fetch the spike owns.
import { createOpenAI } from "@ai-sdk/openai";
import { log, makeOwnedFetch } from "./index.js";

export function createSpikeOpenAI(options) {
    log("sdk-factory.create", {
        optionKeys: Object.keys(options ?? {}).sort(),
        baseURL: options?.baseURL,
        hostFetchType: typeof options?.fetch,
    });
    return createOpenAI({ ...options, fetch: makeOwnedFetch("sdk-factory", options.fetch) });
}
