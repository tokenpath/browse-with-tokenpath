const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const Logic = require("../sidepanel/panel-logic.js");
const extensionRoot = path.resolve(__dirname, "..");
const encoder = new TextEncoder();

function chromeStorage(initial) {
  const values = { ...initial };
  return {
    local: {
      async get(keys) {
        const requested = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(
          requested
            .filter((key) => typeof key === "string" && key in values)
            .map((key) => [key, values[key]])
        );
      },
      async set(next) {
        Object.assign(values, next);
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          delete values[key];
        }
      },
    },
  };
}

function loadClassicClient(
  filename,
  globalName,
  {
    fetch,
    storage = {},
    setTimeout: contextSetTimeout = setTimeout,
    clearTimeout: contextClearTimeout = clearTimeout,
    warnings = [],
  }
) {
  const context = vm.createContext({
    AbortController,
    DOMException,
    ReadableStream,
    Response,
    TextDecoder,
    TextEncoder,
    TokenPathPanelLogic: Logic,
    URL,
    chrome: { storage: chromeStorage(storage) },
    clearTimeout: contextClearTimeout,
    console: {
      warn(...args) {
        warnings.push(args.join(" "));
      },
    },
    fetch,
    setTimeout: contextSetTimeout,
  });
  const source = fs.readFileSync(
    path.join(extensionRoot, "sidepanel", filename),
    "utf8"
  );
  vm.runInContext(source, context, { filename });
  return vm.runInContext(globalName, context);
}

function tokenPathWith(fetch, options = {}) {
  return loadClassicClient("tokenpath.js", "TokenPath", {
    fetch,
    storage: {
      // Only allowlisted origins survive TokenPath.getAuth().
      tokenpathBaseUrl: "http://localhost:8000",
      tokenpathKey: "tpk_test",
    },
    ...options,
  });
}

function byteStreamResponse(chunks, contentType = "text/event-stream") {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": contentType } }
  );
}

function textStreamResponse(text) {
  return byteStreamResponse([encoder.encode(text)]);
}

function sseEvent(name, value, newline = "\n") {
  const data = typeof value === "string" ? value : JSON.stringify(value);
  return `event: ${name}${newline}data: ${data}${newline}${newline}`;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function expectClientError(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code);
    if (status !== undefined) assert.equal(error?.status, status);
    return true;
  });
}

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

test("TokenPath sends the key and document only to allowlisted origins", async () => {
  const accepted = [
    ["https://api.tokenpath.ai", "https://api.tokenpath.ai"],
    ["https://api.tokenpath.ai/", "https://api.tokenpath.ai"],
    ["https://api-staging.tokenpath.ai", "https://api-staging.tokenpath.ai"],
    ["http://localhost:8000", "http://localhost:8000"],
    ["http://localhost:8000/", "http://localhost:8000"],
    ["  http://127.0.0.1:8000  ", "http://127.0.0.1:8000"],
  ];
  for (const [stored, expected] of accepted) {
    const warnings = [];
    const client = loadClassicClient("tokenpath.js", "TokenPath", {
      fetch: async () => jsonResponse({ available_tokens: 1 }),
      storage: { tokenpathBaseUrl: stored, tokenpathKey: "tpk_test" },
      warnings,
    });
    assert.equal((await client.getAuth()).baseUrl, expected, stored);
    assert.deepEqual(warnings, [], `${stored} must not warn`);
  }

  const rejected = [
    "https://evil.example",
    "https://api.tokenpath.ai.evil.example",
    "http://api.tokenpath.ai",
    "https://localhost:8000",
    "http://localhost:8001",
    "https://api.tokenpath.ai/v1",
    "https://api.tokenpath.ai/?to=evil.example",
    "https://api.tokenpath.ai#evil",
    "https://user:pass@api.tokenpath.ai",
    "javascript:alert(1)",
    "not a url",
    "",
    null,
    42,
  ];
  for (const stored of rejected) {
    const warnings = [];
    const client = loadClassicClient("tokenpath.js", "TokenPath", {
      fetch: async () => jsonResponse({ available_tokens: 1 }),
      storage: { tokenpathBaseUrl: stored, tokenpathKey: "tpk_test" },
      warnings,
    });
    assert.equal(
      (await client.getAuth()).baseUrl,
      "https://api.tokenpath.ai",
      `${String(stored)} must fall back to production`
    );
    // Only a value that was actually set and refused is worth a warning.
    const expectedWarnings =
      stored === "" || stored === null || stored === undefined ? 0 : 1;
    assert.equal(warnings.length, expectedWarnings, String(stored));
    // The warning is printed once per panel, not once per request.
    await client.getAuth();
    assert.equal(warnings.length, expectedWarnings, String(stored));
  }
});

test("TokenPath requests an allowlisted origin even with a hostile setting", async () => {
  let capturedUrl = null;
  const client = loadClassicClient("tokenpath.js", "TokenPath", {
    fetch: async (url) => {
      capturedUrl = url;
      return jsonResponse({ available_tokens: 9 });
    },
    storage: {
      tokenpathBaseUrl: "https://attacker.example/collect",
      tokenpathKey: "tpk_test",
    },
  });
  assert.equal(await client.fetchCredits(), 9);
  assert.equal(capturedUrl, "https://api.tokenpath.ai/v1/me/credits");
});

test("TokenPath identifies the extension on every request it makes", async () => {
  // The header is what routes spend to the Browse subscription's allowance
  // instead of the account's credits, so no request type may omit it.
  const seen = [];
  const client = tokenPathWith(async (url, options) => {
    seen.push({
      path: String(url),
      client: options.headers["X-TokenPath-Client"],
      authorization: options.headers.Authorization,
    });
    if (String(url).endsWith("/v1/me/credits")) {
      return jsonResponse({ available_tokens: 5 });
    }
    if (String(url).endsWith("/v1/subscription")) {
      return jsonResponse({
        status: "active",
        renews_at: "2026-09-01T00:00:00Z",
        allowance_tokens: 9_200_000,
        grant_tokens: 10_000_000,
        price_usd_cents: 700,
      });
    }
    if (String(url).endsWith("/v1/generate")) {
      return textStreamResponse(
        sseEvent("done", {
          answer: "Answer.",
          model: "tokenpath/test-model",
          usage: {
            input_tokens: 2,
            output_tokens: 1,
            billed_tokens: 3,
          },
          credits_remaining: 4,
        })
      );
    }
    return jsonResponse(validAttributions);
  });

  await client.fetchCredits();
  await client.fetchSubscription();
  await client.generate({ messages: [{ role: "user", content: "question" }] });
  await client.attributions(attributionInput);

  assert.deepEqual(
    seen.map((request) => request.path),
    [
      "http://localhost:8000/v1/me/credits",
      "http://localhost:8000/v1/subscription",
      "http://localhost:8000/v1/generate",
      "http://localhost:8000/v1/attributions",
    ]
  );
  for (const request of seen) {
    assert.equal(request.client, "browse-extension", request.path);
    assert.equal(request.authorization, "Bearer tpk_test", request.path);
  }
});

test("TokenPath generate parses fragmented SSE and returns canonical done data", async () => {
  const messages = [
    { role: "system", content: "Be concise." },
    { role: "user", content: "Summarize 🎓." },
  ];
  const usage = {
    input_tokens: 11,
    output_tokens: 4,
    billed_tokens: 15,
  };
  const done = {
    answer: "Canonical: Hi 🎓漢字.",
    model: "tokenpath/test-model",
    usage,
    credits_remaining: 12_345,
  };
  const streamText =
    ": generation started\r\n\r\n" +
    sseEvent("delta", { text: "Hi 🎓" }, "\r\n") +
    sseEvent("progress", { phase: "generating" }, "\r\n") +
    sseEvent("delta", { text: "漢字" }, "\r\n") +
    sseEvent("done", done, "\r\n");
  const bytes = encoder.encode(streamText);
  const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));
  let capturedRequest = null;
  const client = tokenPathWith(async (url, options) => {
    capturedRequest = { url, options };
    return byteStreamResponse(chunks);
  });
  const accumulated = [];

  const result = await client.generate({
    messages,
    maxOutputTokens: 128,
    onDelta(_delta, answer) {
      accumulated.push(answer);
    },
  });

  assert.equal(capturedRequest.url, "http://localhost:8000/v1/generate");
  assert.equal(capturedRequest.options.method, "POST");
  assert.equal(
    capturedRequest.options.headers.Authorization,
    "Bearer tpk_test"
  );
  assert.equal(capturedRequest.options.headers.Accept, "text/event-stream");
  assert.deepEqual(JSON.parse(capturedRequest.options.body), {
    messages,
    max_output_tokens: 128,
  });
  assert.equal(result.answer, done.answer);
  assert.notEqual(result.answer, accumulated.at(-1));
  assert.equal(result.model, done.model);
  assert.deepEqual(plain(result.usage), usage);
  assert.equal(result.creditsRemaining, done.credits_remaining);
  assert.deepEqual(accumulated, ["Hi 🎓", "Hi 🎓漢字"]);
});

test("TokenPath generate accepts a done event terminated by EOF", async () => {
  const done = {
    answer: "Complete.",
    model: "tokenpath/test-model",
    usage: {
      input_tokens: 2,
      output_tokens: 1,
      billed_tokens: 3,
    },
    credits_remaining: null,
  };
  const streamText =
    sseEvent("delta", { text: "Complete" }) +
    `event: done\ndata: ${JSON.stringify(done)}`;
  const client = tokenPathWith(async () => textStreamResponse(streamText));
  const result = await client.generate({
    messages: [{ role: "user", content: "question" }],
  });
  assert.deepEqual(plain(result), {
    answer: done.answer,
    model: done.model,
    usage: done.usage,
    creditsRemaining: null,
  });
});

test("TokenPath generate rejects malformed and incomplete streams", async () => {
  const malformed = tokenPathWith(async () =>
    textStreamResponse("event: delta\ndata: {not-json}\n\n")
  );
  await expectClientError(
    malformed.generate({
      messages: [{ role: "user", content: "question" }],
    }),
    "invalid_stream",
    200
  );

  const incomplete = tokenPathWith(async () =>
    textStreamResponse(sseEvent("delta", { text: "partial" }))
  );
  await assert.rejects(
    incomplete.generate({
      messages: [{ role: "user", content: "question" }],
    }),
    (error) => {
      assert.equal(error?.code, "incomplete_stream");
      assert.equal(error?.details?.partialAnswer, "partial");
      return true;
    }
  );
});

test("TokenPath generate preserves partial text on a stream error event", async () => {
  const streamText =
    sseEvent("delta", { text: "partial" }) +
    sseEvent("error", {
      error: {
        code: "generation_failed",
        message: "The generation backend failed.",
        request_id: "req_stream_test",
      },
    });
  const client = tokenPathWith(async () => textStreamResponse(streamText));

  await assert.rejects(
    client.generate({
      messages: [{ role: "user", content: "question" }],
    }),
    (error) => {
      assert.equal(error?.status, 200);
      assert.equal(error?.code, "generation_failed");
      assert.equal(error?.message, "The generation backend failed.");
      assert.equal(error?.details?.partialAnswer, "partial");
      assert.equal(error?.details?.requestId, "req_stream_test");
      return true;
    }
  );
});

function stalledSseResponse(signal, firstEvent) {
  return new Response(
    new ReadableStream({
      start(controller) {
        const abort = () =>
          controller.error(new DOMException("Aborted", "AbortError"));
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
        controller.enqueue(encoder.encode(firstEvent));
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

test("TokenPath generate caller abort cancels an active response stream", async () => {
  const external = new AbortController();
  let sawDelta = false;
  const client = tokenPathWith(async (_url, options) =>
    stalledSseResponse(
      options.signal,
      sseEvent("delta", { text: "first" })
    )
  );

  await expectClientError(
    client.generate({
      messages: [{ role: "user", content: "question" }],
      signal: external.signal,
      onDelta() {
        sawDelta = true;
        external.abort();
      },
    }),
    "aborted",
    0
  );
  assert.equal(sawDelta, true);
});

test("TokenPath generate closes the connection when a stream event throws", async () => {
  const failingEvents = [
    ["invalid_stream", "event: delta\ndata: {not-json}\n\n"],
    ["invalid_stream", sseEvent("delta", { text: 7 })],
    [
      "generation_failed",
      sseEvent("error", {
        error: {
          code: "generation_failed",
          message: "The generation backend failed.",
        },
      }),
    ],
  ];

  for (const [code, event] of failingEvents) {
    let aborted = false;
    const client = tokenPathWith(async (_url, options) => {
      options.signal.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true }
      );
      // The server keeps the response open after the offending event, exactly
      // as a real stalled or erroring stream would.
      return stalledSseResponse(options.signal, event);
    });

    await expectClientError(
      client.generate({
        messages: [{ role: "user", content: "question" }],
      }),
      code,
      200
    );
    assert.equal(aborted, true, `${code} must close the HTTP connection`);
  }
});

test("TokenPath generate times out while an active stream is idle", async () => {
  const fastSetTimeout = (callback, delay, ...args) =>
    setTimeout(callback, delay === 90_000 ? 10 : delay, ...args);
  const client = tokenPathWith(
    async (_url, options) =>
      stalledSseResponse(
        options.signal,
        sseEvent("delta", { text: "partial" })
      ),
    { setTimeout: fastSetTimeout }
  );

  await assert.rejects(
    client.generate({
      messages: [{ role: "user", content: "question" }],
    }),
    (error) => {
      assert.equal(error?.status, 0);
      assert.equal(error?.code, "timeout");
      assert.equal(error?.details?.partialAnswer, "partial");
      return true;
    }
  );
});

test("TokenPath generate preserves structured HTTP errors", async () => {
  const client = tokenPathWith(async () =>
    jsonResponse(
      {
        error: {
          code: "insufficient_credits",
          message: "Not enough generation credits.",
          details: { available_tokens: 7 },
          request_id: "req_http_test",
        },
      },
      402
    )
  );

  await assert.rejects(
    client.generate({
      messages: [{ role: "user", content: "question" }],
    }),
    (error) => {
      assert.equal(error?.status, 402);
      assert.equal(error?.code, "insufficient_credits");
      assert.equal(error?.message, "Not enough generation credits.");
      assert.equal(error?.details?.available_tokens, 7);
      assert.equal(error?.details?.requestId, "req_http_test");
      return true;
    }
  );
});

test("TokenPath generate validates terminal done metadata", async () => {
  const validDone = {
    answer: "Answer.",
    model: "tokenpath/test-model",
    usage: {
      input_tokens: 2,
      output_tokens: 1,
      billed_tokens: 3,
    },
    credits_remaining: 100,
  };
  const withoutCredits = { ...validDone };
  delete withoutCredits.credits_remaining;
  const invalidDoneEvents = [
    { ...validDone, answer: "" },
    { ...validDone, model: " " },
    {
      ...validDone,
      usage: { ...validDone.usage, input_tokens: -1 },
    },
    {
      ...validDone,
      usage: { ...validDone.usage, output_tokens: 1.5 },
    },
    { ...validDone, credits_remaining: -1 },
    withoutCredits,
  ];

  for (const done of invalidDoneEvents) {
    const client = tokenPathWith(async () =>
      textStreamResponse(sseEvent("done", done))
    );
    await expectClientError(
      client.generate({
        messages: [{ role: "user", content: "question" }],
      }),
      "invalid_stream",
      200
    );
  }
});

const attributionInput = {
  document: "x🎓y漢",
  question: "Where?",
  answer: "🙂A🚀",
};
const validAttributions = {
  offset_encoding: "utf-16",
  spans: [
    {
      answer: { start: 0, end: 2, text: "🙂" },
      source: { start: 1, end: 3, text: "🎓", confidence: 0.75 },
    },
    {
      answer: { start: 2, end: 3, text: "A" },
      source: { start: 3, end: 4, text: "y", confidence: 0.5 },
    },
  ],
};

test("TokenPath validates and returns server-selected UTF-16 spans", async () => {
  let request;
  const client = tokenPathWith(async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return jsonResponse(validAttributions);
  });
  const result = await client.attributions(attributionInput);

  assert.equal(request.url, "http://localhost:8000/v1/attributions");
  assert.deepEqual(request.body, {
    ...attributionInput,
    offset_encoding: "utf-16",
  });
  assert.ok(!("threshold" in request.body));
  assert.ok(!("spans" in request.body));
  assert.deepEqual(plain(result), validAttributions.spans);
});

test("TokenPath rejects malformed attribution spans", async () => {
  const malformed = [
    null,
    {},
    { spans: {}, offset_encoding: "utf-16" },
    { ...validAttributions, offset_encoding: "utf-32" },
    { ...validAttributions, spans: [null] },
    {
      ...validAttributions,
      spans: [{ ...validAttributions.spans[0], answer: { start: 0, end: 2, text: "x" } }],
    },
    {
      ...validAttributions,
      spans: [{ ...validAttributions.spans[0], source: { ...validAttributions.spans[0].source, confidence: 1.1 } }],
    },
    {
      ...validAttributions,
      spans: [{
        answer: { start: 0, end: 1, text: "\ud83d" },
        source: validAttributions.spans[0].source,
      }],
    },
    {
      ...validAttributions,
      spans: [validAttributions.spans[1], validAttributions.spans[0]],
    },
  ];

  for (const body of malformed) {
    const client = tokenPathWith(async () => jsonResponse(body));
    await expectClientError(
      client.attributions(attributionInput),
      "invalid_response",
      200
    );
  }
});

test("TokenPath accepts no spans and filters null source results", async () => {
  const empty = tokenPathWith(async () =>
    jsonResponse({ spans: [], offset_encoding: "utf-16" })
  );
  assert.deepEqual(plain(await empty.attributions(attributionInput)), []);

  const unresolved = tokenPathWith(async () =>
    jsonResponse({
      spans: [{ answer: { start: 0, end: 2, text: "🙂" }, source: null }],
      offset_encoding: "utf-16",
    })
  );
  assert.deepEqual(plain(await unresolved.attributions(attributionInput)), []);
});

test("TokenPath reads a subscription, and a missing endpoint means none", async () => {
  const active = tokenPathWith(async () =>
    jsonResponse({
      status: "active",
      renews_at: "2026-09-01T00:00:00Z",
      allowance_tokens: 9_200_000,
      grant_tokens: 10_000_000,
      price_usd_cents: 700,
    })
  );
  assert.deepEqual(plain(await active.fetchSubscription()), {
    status: "active",
    renewsAt: "2026-09-01T00:00:00Z",
    allowanceTokens: 9_200_000,
    grantTokens: 10_000_000,
    priceUsdCents: 700,
  });

  const canceling = tokenPathWith(async () =>
    jsonResponse({
      status: "canceling",
      renews_at: "2026-09-01T00:00:00Z",
      allowance_tokens: 0,
    })
  );
  assert.deepEqual(plain(await canceling.fetchSubscription()), {
    status: "canceling",
    renewsAt: "2026-09-01T00:00:00Z",
    allowanceTokens: 0,
    // A response that omits the two fixed plan fields still describes the
    // shipped plan rather than a broken one.
    grantTokens: 10_000_000,
    priceUsdCents: 700,
  });

  const none = tokenPathWith(async () =>
    jsonResponse({
      status: "none",
      renews_at: null,
      allowance_tokens: 0,
      grant_tokens: 10_000_000,
      price_usd_cents: 700,
    })
  );
  assert.equal((await none.fetchSubscription()).status, "none");

  // The endpoint ships after this client does. Until it exists, every account
  // simply has no subscription — silently, with no error anywhere.
  const undeployed = tokenPathWith(async () =>
    jsonResponse(
      { error: { code: "not_found", message: "Unknown endpoint." } },
      404
    )
  );
  assert.deepEqual(plain(await undeployed.fetchSubscription()), {
    status: "none",
    renewsAt: null,
    allowanceTokens: 0,
    grantTokens: 10_000_000,
    priceUsdCents: 700,
  });

  // Tolerance stops at 404: a rejected key or a broken service still has to
  // reach the paths that handle them.
  for (const [status, code] of [
    [401, "invalid_api_key"],
    [403, "forbidden"],
    [500, "http_500"],
  ]) {
    const failing = tokenPathWith(async () =>
      jsonResponse(
        status === 500
          ? {}
          : { error: { code, message: "Nope." } },
        status
      )
    );
    await expectClientError(failing.fetchSubscription(), code, status);
  }
});

test("TokenPath validates the subscription contract shape", async () => {
  const malformed = [
    {},
    { status: "trialing", allowance_tokens: 0 },
    { status: null, allowance_tokens: 0 },
    { status: "active", renews_at: 20_260_901, allowance_tokens: 0 },
    { status: "active", renews_at: null, allowance_tokens: -1 },
    { status: "active", renews_at: null, allowance_tokens: 1.5 },
    { status: "active", renews_at: null, allowance_tokens: "9200000" },
    { status: "active", allowance_tokens: 0, grant_tokens: -10 },
    { status: "active", allowance_tokens: 0, price_usd_cents: "700" },
  ];

  for (const body of malformed) {
    const client = tokenPathWith(async () => jsonResponse(body));
    await expectClientError(
      client.fetchSubscription(),
      "invalid_response",
      200
    );
  }
});

function stalledJsonResponse(signal, bodyStarted) {
  return {
    ok: true,
    status: 200,
    async json() {
      bodyStarted();
      return new Promise((resolve, reject) => {
        let fallback = null;
        const abort = () => {
          if (fallback !== null) clearTimeout(fallback);
          reject(new DOMException("Aborted", "AbortError"));
        };
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
        fallback = setTimeout(
          () => reject(new Error("Response body was not cancelled")),
          250
        );
      });
    },
  };
}

test("TokenPath caller abort remains active while JSON is read", async () => {
  const external = new AbortController();
  let bodyStartedResolve;
  const bodyStarted = new Promise((resolve) => {
    bodyStartedResolve = resolve;
  });
  const client = tokenPathWith(async (_url, options) =>
    stalledJsonResponse(options.signal, bodyStartedResolve)
  );

  const pending = client.attributions({
    ...attributionInput,
    signal: external.signal,
  });
  await bodyStarted;
  external.abort();
  await expectClientError(pending, "aborted", 0);
});

test("TokenPath timeout remains active while JSON is read", async () => {
  let bodyStartedResolve;
  const bodyStarted = new Promise((resolve) => {
    bodyStartedResolve = resolve;
  });
  const fastSetTimeout = (callback, delay, ...args) =>
    setTimeout(callback, delay === 90_000 ? 10 : delay, ...args);
  const client = tokenPathWith(
    async (_url, options) =>
      stalledJsonResponse(options.signal, bodyStartedResolve),
    { setTimeout: fastSetTimeout }
  );

  const pending = client.attributions(attributionInput);
  await bodyStarted;
  await expectClientError(pending, "timeout", 0);
});

(async () => {
  let failures = 0;
  for (const { name, run } of tests) {
    try {
      await run();
      console.log(`PASS: ${name}`);
    } catch (error) {
      failures++;
      console.error(`FAIL: ${name}`);
      console.error(error);
    }
  }
  if (failures) {
    process.exitCode = 1;
    throw new Error(`${failures} API client test(s) failed.`);
  }
  console.log("\nAll API client assertions passed.");
})().catch((error) => {
  if (!process.exitCode) process.exitCode = 1;
  console.error(error);
});
