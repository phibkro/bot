import { Effect, Layer, Redacted } from "effect";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http";
import type { HttpClientRequest } from "effect/http";

import { GitHubApp } from "../src/index.ts";

/** An HTTP client that answers from a function and records every request (method, url, headers, body text). */
export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface FakeReply {
  readonly status: number;
  readonly body?: string | object;
  readonly headers?: Readonly<Record<string, string>>;
}

const decoder = new TextDecoder();

const bodyText = (request: HttpClientRequest.HttpClientRequest): string =>
  request.body._tag === "Uint8Array" ? decoder.decode(request.body.body) : "";

const webResponse = (reply: FakeReply, init: ResponseInit): Response => {
  if (reply.status === 204 || reply.body === undefined) {
    return new Response(null, init);
  }

  return typeof reply.body === "string"
    ? new Response(reply.body, init)
    : Response.json(reply.body, init);
};

export const fakeHttp = (answer: (request: RecordedRequest) => FakeReply) => {
  const requests: RecordedRequest[] = [];

  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const recorded: RecordedRequest = {
        body: bodyText(request),
        headers: { ...request.headers },
        method: request.method,
        url:
          request.url +
          (request.urlParams.params.length === 0
            ? ""
            : `?${UrlParams.toString(request.urlParams)}`),
      };

      requests.push(recorded);
      const reply = answer(recorded);
      const init = { headers: reply.headers ?? {}, status: reply.status };

      const web = webResponse(reply, init);

      return Effect.succeed(HttpClientResponse.fromWeb(request, web));
    })
  );

  return { layer, requests };
};

/** The token a test GitHub App mints: a value that must never appear in an error, a log or an audit row. */
export const testToken = "ghs_TEST_TOKEN_VALUE_MUST_NOT_LEAK";

export const fakeApp = Layer.succeed(
  GitHubApp,
  GitHubApp.of({
    installationOf: () => Effect.succeed(5),
    token: () => Effect.succeed(Redacted.make(testToken)),
  })
);
