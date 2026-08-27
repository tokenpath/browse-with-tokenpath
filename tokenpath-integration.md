# Generation and Attribution in Browse with TokenPath

> **Status (2026-07): live single-provider implementation.** TokenPath streams
> generation from a messages-only `/v1/generate` request, then receives the
> final answer once and returns reusable attribution spans. One TokenPath
> key covers the complete flow.

## Current request flow

The side panel is an extension page, so declared host permissions let it call
TokenPath without a proxy backend. The API key lives in `chrome.storage.local`.

The extension uses four requests:

1. `GET https://api.tokenpath.ai/v1/me/credits` validates the TokenPath key and
   refreshes the displayed balance.
2. `GET https://api.tokenpath.ai/v1/subscription` reads the Browse
   subscription's state and remaining monthly allowance.
3. `POST https://api.tokenpath.ai/v1/generate` streams one answer.
4. `POST https://api.tokenpath.ai/v1/attributions` attributes that exact
   final displayed answer once.

The returned answer/source spans are cached with the assistant message. Clicking
an attributed phrase routes its source bounds directly to the source frame.

## Authentication and errors

Requests receive the TokenPath bearer token and identify the client:

```http
Authorization: Bearer <provider key>
X-TokenPath-Client: browse-extension
Content-Type: application/json
```

`X-TokenPath-Client` is on every request the panel makes — credits,
subscription, generation, and attribution alike. It is what routes spend to the
Browse subscription's monthly allowance, falling back to the account's prepaid
credits once that allowance is used up; the identical request without the header
spends credits.

The extension handles rejected keys (`401`/`403`), insufficient credits (`402`),
rate limits (`429`), network failures, cancellation, invalid responses, and
90-second idle or request timeouts. A `402` re-reads the balance and the
subscription before it words anything, because the response says the request
could not be paid for but not out of which pool; `spec.md` has the three
messages that follow. A generation error is shown as an assistant
error message. An attribution error leaves the generated answer visible and marks
only its source map unavailable.

TokenPath defaults to `https://api.tokenpath.ai`. For staging or local
development, set `tokenpathBaseUrl` in extension storage:

```js
chrome.storage.local.set({ tokenpathBaseUrl: "http://localhost:8000" })
```

That value is a developer convenience, not a routing instruction: every request
carries the API key and the complete captured page text, so `tokenpath.js`
accepts only these exact origins and ignores anything else, falling back to
production with a one-time console warning.

| Allowed base URL |
|---|
| `https://api.tokenpath.ai` (default) |
| `https://api-staging.tokenpath.ai` |
| `http://localhost:8000` |
| `http://127.0.0.1:8000` |

A trailing slash is tolerated. A path, query string, fragment, or userinfo is
not — the value must be a bare origin from the list. The staging and localhost
origins are also the only host permissions the store package drops, so this
override is usable in an unpacked build only.

## The Browse subscription

```http
GET https://api.tokenpath.ai/v1/subscription
```

```json
{
  "status": "active",
  "renews_at": "2026-09-01T00:00:00Z",
  "allowance_tokens": 9200000,
  "grant_tokens": 10000000,
  "price_usd_cents": 700
}
```

`status` is `none`, `active`, or `canceling` — a canceling subscription is still
a paid month, so its allowance is spendable and `renews_at` is when it *ends*.
`allowance_tokens` is what remains of this month's grant; only it moves as
tokens are spent. The client validates the status, the renewal date, and every
count, and reads an omitted `grant_tokens` or `price_usd_cents` as the shipped
plan rather than as a broken response.

**A `404` means "no subscription", not an error.** The endpoint is newer than
the shipped client, so an installation talking to a backend that does not serve
it yet resolves silently to the `none` plan and behaves exactly as it does
today: the badge shows credits, Settings offers the plan, and an out-of-tokens
message points at credits. Every other status — a rejected key included —
follows the ordinary error mapping.

## TokenPath generation

Generation uses:

```http
POST https://api.tokenpath.ai/v1/generate
Accept: text/event-stream
Content-Type: application/json
```

The request is deliberately messages-only apart from its output ceiling:

```json
{
  "max_output_tokens": 2048,
  "messages": [
    {
      "role": "system",
      "content": "Website origin, Markdown formatting guidance, and the exact selected document"
    },
    {
      "role": "user",
      "content": "The latest question"
    }
  ]
}
```

The system message identifies the website origin, asks the model to answer the
user's question, and requests concise Markdown with bullets or tables only when
they improve readability. Bounded prior user and assistant turns sit between
the system message and latest question.

The API accepts 1–50 messages, requires the last role to be `user`, caps total
message content at 420,000 characters, and accepts `max_output_tokens` from 16
through 2048. The controller keeps the exact document as large as possible,
then packs recent history backward within both caps. Generation is billed from
all submitted message content; the returned `billed_tokens` and
`credits_remaining` update the panel without an extra balance request.

TokenPath selects the inexpensive model and adds no prompt of its own. The
response uses named server-sent events:

```text
event: delta
data: {"text":"partial answer"}

event: done
data: {"answer":"canonical complete answer","model":"...","usage":{"input_tokens":42,"output_tokens":10,"billed_tokens":37},"credits_remaining":9999963}
```

The client parses events incrementally, including names and JSON split across
network chunks or UTF-8 byte boundaries. It updates one stable assistant
message from `delta.text`, then uses `done.answer` as the canonical final
string. A terminal `error` event carries the normal TokenPath error envelope.
A new capture, navigation, or disconnect cancels in-flight generation.

Generation is only ever started by a user action — a submitted question or the
panel's **Summarize** starter. A capture by itself makes no request.

For the summary pathway, sources of 24 words or fewer make no request at all
(CJK-dominant text uses a 48-character cutoff); the panel posts an “Already
concise” note instead. Every longer source gets one of two prompts — the
default asking for exactly 3 one-sentence Markdown bullet points, most
important first, or a Detailed one asking for a structured summary in sections
— or the user's own instructions in place of either. All three share the same
suffix and the same `max_output_tokens: 2048`. That ceiling is TokenPath's maximum and is what
every generation path sends — summaries and ordinary questions alike — because
generation is billed from the input text, so a lower ceiling saves nothing and
only risks stopping mid-sentence. The ceiling leaves completion headroom;
prompt wording controls the intended length. An answer that produces every
token it was allowed gets a note saying it reached the maximum answer length,
and stays attributed. The client does not clip or replace the result: the exact
terminal
`done.answer` is used for the UI, conversation history, and attribution request.

### The suggestions tail

When follow-up suggestions are enabled, the panel appends one fixed instruction
after the latest question in the **outgoing user message only**, asking the
model to end its answer with a block of four Q/A pairs:

```text
<<<SUGGESTIONS
Q: <question strictly answerable from the provided text, about material not already covered by this answer>
A: "<verbatim quote of at most 10 words from the provided text that the answer to this question would cite>"
Q: ...
A: "..."
SUGGESTIONS>>>
```

This is a client-side convention, not a TokenPath feature: `/v1/generate` is
unchanged and TokenPath adds no prompt of its own. Riding along on the answer's
own call is what makes it free — generation is billed from the input text, so a
separate request would re-pay for the whole document to obtain two questions,
while the extra output tokens cost nothing.

The block therefore appears in `done.answer` (and in the trailing `delta`
events). **The panel strips it before anything else sees the answer.** Every
complete block, a stray closing marker, and an opener the stream never closed
are removed from each streaming delta and from the terminal answer, so:

- the rendered answer never shows the marker, not even mid-stream;
- `POST /v1/attributions` receives the stripped answer — the block is never
  part of the `answer` field and therefore never receives attribution spans;
- the conversation history and the cached page chat store the stripped answer;
  and
- the `question` field of the attribution request is the question **without** the
  tail, because the tail is added to the outgoing message only.

An answer that carries no block is passed through byte for byte. A malformed
block yields no suggestions and never garbles the answer. The panel then keeps
only candidates whose anchor quote occurs verbatim in the captured document and
whose anchors lie outside the returned source regions, and shows at
most two.

Cancellation is not always discarding. Navigation, a newer capture, or
disconnect drops the turn, but the composer's **Stop** button and a mid-stream
network failure both keep the partial answer, flagged incomplete. Neither sends
an attribution request for it: attributing an unfinished answer would map text the
model never produced.

## TokenPath attribution spans

The client sends:

```http
POST /v1/attributions
```

```json
{
  "document": "the exact canonical extracted source",
  "question": "the latest user turn",
  "answer": "the exact final displayed answer"
}
```

The client deliberately sends neither `spans` nor `threshold`: TokenPath uses
its defaults to discover source-bearing answer phrases. The expected response
contains half-open UTF-16 ranges against the exact submitted strings:

```json
{
  "offset_encoding": "utf-16",
  "spans": [{
    "answer": { "start": 13, "end": 16, "text": "18%" },
    "source": {
      "start": 32,
      "end": 35,
      "text": "18%",
      "confidence": 0.82
    }
  }]
}
```

The adapter verifies:

- the response contains a spans array and uses UTF-16 offsets;
- answer and source bounds are ordered, non-overlapping, integer, in-range, and
  slice to the returned `text` exactly;
- confidences are finite values from `0` through `1`; and
- a nullable source is accepted but omitted from clickable results.

Rendered Markdown cannot be indexed directly because delimiters, entities,
hidden destinations, and block structure alter its DOM text.
`answer-selection.ts` builds a source-positioned visible-text map from the same
GFM and maps each server-returned answer span to a DOM `Range`. This preserves
underlines and pointer hit-testing across emphasis, links, code, entities,
blocks, repeats, and Unicode. Clicking the range or activating its entry in the
**Sources (n)** list sends the returned source span directly; arbitrary answer
text selection is only a normal browser copy interaction.

## Capture and source navigation

The originating `tabId`, `frameId`, and `captureId` are preserved from capture
through generation, attribution caching, and highlight routing. The immutable
attribution artifact also retains the exact canonical document and complete
attribution prompt transcript used for that answer, and is what a restored
page-chat replays: cached chats keep each distinct document once per record and
reference it from the answers attributed against it, so reopening a page needs
no TokenPath request at all.

Once a source range is resolved, the existing content-script machinery maps its
canonical document offsets to live DOM nodes. If those nodes were replaced, it
searches only inside the original Gmail or WhatsApp message, X
post/status/article identity, uniquely headed semantic article, or conservative
generic scope. Context and exact source identity disambiguate repeats. Changed
routes, changed target text, surviving duplicates, and ambiguous matches fail
instead of highlighting an arbitrary occurrence.

Because the highlight message carries the cached canonical document, a frame
that reloaded since the answer was attributed can still recover: it re-derives
the quote and its bounded surrounding context from that document and locates
them in the fresh DOM. The same fail-closed rules apply, so a genuinely changed
or vanished passage reports a failure rather than moving the highlight.

Each navigation request also carries an opaque highlight ownership ID. Cleanup
from an older attribution click can only remove the highlight it created, so
rapid clicks cannot let a delayed response clear the newer result.

## Data and privacy

TokenPath receives the exact extracted selection, rendered full-page text, or
searchable full-PDF text, plus the generator instructions, bounded conversation
text, current user request, and generated answer. Generation receives that
context as role-based messages. The attribution request receives the bare document,
a `question` transcript containing the generator instructions, bounded
conversation history, and clean current user request, plus the canonical answer.
The internal follow-up-suggestion tail is excluded from that transcript.

TokenPath does not receive DOM nodes, page structure, the extraction-to-node
map, or the user's native browser selection object.

## Separation of concerns

`/v1/generate` returns plain answer text with no citations, marker syntax, or
attribution spans. `/v1/attributions` remains a separate, model-independent
call that selects answer phrases and resolves their source spans. The old
bundled `/v1/answer` flow is not part of this architecture.
