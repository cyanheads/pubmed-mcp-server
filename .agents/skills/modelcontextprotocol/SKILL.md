---
name: modelcontextprotocol
description: MCP specification and SDK reference links. Use when you need to look up MCP docs, spec sections, GitHub repos, or SDK links — NOT as general context for MCP development tasks.
user-invokable: true
---

# Model Context Protocol (MCP)

Open standard for connecting AI applications to external data sources, tools, and workflows. JSON-RPC 2.0 based, with defined primitives and transport layers.

## When to Use

- Building an MCP server (tools, resources, prompts)
- Building an MCP client
- Working with MCP transports (stdio, Streamable HTTP)
- Implementing MCP authorization (OAuth 2.1)
- Referencing MCP spec behavior or capabilities

## Architecture

```
Host (AI app)
 └─ Client (1:1 with server)
     └─ Server (exposes primitives)
```

- **Host**: The AI application (Codex Desktop, IDE, agent framework)
- **Client**: Maintains a stateful session with one server. Handles capability negotiation.
- **Server**: Exposes tools, resources, and prompts over a transport.

Servers can be **local** (stdio, launched as subprocess) or **remote** (Streamable HTTP, requires auth).

## Primitives

| Primitive       | Direction       | Purpose                                                      |
| --------------- | --------------- | ------------------------------------------------------------ |
| **Tools**       | Server → Client | Functions the model can call (side effects, computation)     |
| **Resources**   | Server → Client | Read-only data the client can attach as context              |
| **Prompts**     | Server → Client | Templated messages/workflows for specific tasks              |
| **Sampling**    | Client → Server | Server requests an LLM completion from the client            |
| **Elicitation** | Client → Server | Server requests structured user input from the client        |
| **Roots**       | Client → Server | Client tells the server which filesystem roots it can access |

## Transports

| Transport           | Use Case       | Notes                                                      |
| ------------------- | -------------- | ---------------------------------------------------------- |
| **stdio**           | Local servers  | Launched as subprocess, pipes for communication            |
| **Streamable HTTP** | Remote servers | Single HTTP endpoint, supports SSE streaming, resumability |

Legacy SSE transport (separate `/sse` + `/messages` endpoints) is deprecated as of 2025-11-25.

## Lifecycle

1. **Initialize**: Client sends `initialize` with capabilities → server responds with its capabilities
2. **Initialized**: Client sends `initialized` notification → normal operation begins
3. **Operation**: Request/response and notifications flow per negotiated capabilities
4. **Shutdown**: Either side terminates cleanly via transport close

## Capability Negotiation

Both client and server declare capabilities during initialization. Only use features the other side declared support for.

**Server capabilities**: `tools`, `resources`, `prompts`, `logging`, `completions`
**Client capabilities**: `sampling`, `elicitation`, `roots`

## TypeScript SDK

Current stable: **v1.x** (`@modelcontextprotocol/sdk`)
Next: **v2** (pre-alpha, monorepo with `@modelcontextprotocol/server`, `@modelcontextprotocol/client`)

### v1.x Server (Stable)

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'my-server',
  version: '1.0.0',
});

// Tool
server.tool('add', { a: z.number(), b: z.number() }, async ({ a, b }) => ({
  content: [{ type: 'text', text: String(a + b) }],
}));

// Resource
server.resource('config', 'config://app', async (uri) => ({
  contents: [{ uri: uri.href, mimeType: 'application/json', text: '{}' }],
}));

// Prompt
server.prompt('review', { code: z.string() }, ({ code }) => ({
  messages: [
    { role: 'user', content: { type: 'text', text: `Review:\n${code}` } },
  ],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
```

### v1.x Client (Stable)

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['./server.js'],
});

const client = new Client({ name: 'my-client', version: '1.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
const result = await client.callTool({
  name: 'add',
  arguments: { a: 1, b: 2 },
});
```

### Streamable HTTP Transport (v1.x)

```typescript
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';

const app = express();
app.use(express.json());

app.all('/mcp', async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
});
```

## Tool Patterns

### Return types

```typescript
// Text
{ content: [{ type: "text", text: "result" }] }

// Error (isError flag)
{ content: [{ type: "text", text: "Not found" }], isError: true }

// Image
{ content: [{ type: "image", data: base64String, mimeType: "image/png" }] }

// Multiple content items
{ content: [
  { type: "text", text: "Caption" },
  { type: "image", data: base64String, mimeType: "image/png" }
]}
```

### Annotations

Tools can declare `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` to help clients make decisions about confirmation and safety.

## Specification

Latest spec version: **2025-11-25**

| Section       | URL                                                                                   |
| ------------- | ------------------------------------------------------------------------------------- |
| Overview      | https://modelcontextprotocol.io/specification/2025-11-25                              |
| Architecture  | https://modelcontextprotocol.io/specification/2025-11-25/architecture                 |
| Lifecycle     | https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle              |
| Transports    | https://modelcontextprotocol.io/specification/2025-11-25/basic/transports             |
| Authorization | https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization          |
| Tools         | https://modelcontextprotocol.io/specification/2025-11-25/server/tools                 |
| Resources     | https://modelcontextprotocol.io/specification/2025-11-25/server/resources             |
| Prompts       | https://modelcontextprotocol.io/specification/2025-11-25/server/prompts               |
| Sampling      | https://modelcontextprotocol.io/specification/2025-11-25/client/sampling              |
| Elicitation   | https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation           |
| Roots         | https://modelcontextprotocol.io/specification/2025-11-25/client/roots                 |
| Logging       | https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/logging     |
| Completion    | https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/completion  |
| Pagination    | https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/pagination  |
| Cancellation  | https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation |
| Progress      | https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress     |
| Tasks         | https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks        |
| Changelog     | https://modelcontextprotocol.io/specification/2025-11-25/changelog                    |
| Schema        | https://modelcontextprotocol.io/specification/2025-11-25/schema                       |
| Versioning    | https://modelcontextprotocol.io/specification/versioning                              |

## Documentation

| Page                    | URL                                                                             |
| ----------------------- | ------------------------------------------------------------------------------- |
| Introduction            | https://modelcontextprotocol.io/docs/getting-started/intro                      |
| Architecture            | https://modelcontextprotocol.io/docs/learn/architecture                         |
| Server Concepts         | https://modelcontextprotocol.io/docs/learn/server-concepts                      |
| Client Concepts         | https://modelcontextprotocol.io/docs/learn/client-concepts                      |
| Build a Server          | https://modelcontextprotocol.io/docs/develop/build-server                       |
| Build a Client          | https://modelcontextprotocol.io/docs/develop/build-client                       |
| Connect Local Servers   | https://modelcontextprotocol.io/docs/develop/connect-local-servers              |
| Connect Remote Servers  | https://modelcontextprotocol.io/docs/develop/connect-remote-servers             |
| Authorization Tutorial  | https://modelcontextprotocol.io/docs/tutorials/security/authorization           |
| Security Best Practices | https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices |
| Inspector               | https://modelcontextprotocol.io/docs/tools/inspector                            |
| SDKs                    | https://modelcontextprotocol.io/docs/sdk                                        |
| Clients List            | https://modelcontextprotocol.io/clients                                         |
| Examples                | https://modelcontextprotocol.io/examples                                        |
| Roadmap                 | https://modelcontextprotocol.io/development/roadmap                             |
| LLM-friendly docs       | https://modelcontextprotocol.io/llms.txt                                        |

## GitHub Repositories

| Repo                                                                                 | Purpose                                |
| ------------------------------------------------------------------------------------ | -------------------------------------- |
| [specification](https://github.com/modelcontextprotocol/modelcontextprotocol)        | Spec and docs source                   |
| [typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk)             | Official TypeScript SDK                |
| [python-sdk](https://github.com/modelcontextprotocol/python-sdk)                     | Official Python SDK                    |
| [go-sdk](https://github.com/modelcontextprotocol/go-sdk)                             | Official Go SDK (with Google)          |
| [rust-sdk](https://github.com/modelcontextprotocol/rust-sdk)                         | Official Rust SDK                      |
| [java-sdk](https://github.com/modelcontextprotocol/java-sdk)                         | Official Java SDK (with Spring AI)     |
| [kotlin-sdk](https://github.com/modelcontextprotocol/kotlin-sdk)                     | Official Kotlin SDK (with JetBrains)   |
| [swift-sdk](https://github.com/modelcontextprotocol/swift-sdk)                       | Official Swift SDK                     |
| [csharp-sdk](https://github.com/modelcontextprotocol/csharp-sdk)                     | Official C# SDK (with Microsoft)       |
| [ruby-sdk](https://github.com/modelcontextprotocol/ruby-sdk)                         | Official Ruby SDK (with Shopify)       |
| [php-sdk](https://github.com/modelcontextprotocol/php-sdk)                           | Official PHP SDK (with PHP Foundation) |
| [servers](https://github.com/modelcontextprotocol/servers)                           | Official reference servers             |
| [inspector](https://github.com/modelcontextprotocol/inspector)                       | Visual testing tool for MCP servers    |
| [registry](https://github.com/modelcontextprotocol/registry)                         | Community MCP server registry          |
| [conformance](https://github.com/modelcontextprotocol/conformance)                   | Conformance test suite                 |
| [quickstart-resources](https://github.com/modelcontextprotocol/quickstart-resources) | Tutorial starter code                  |
| [ext-apps](https://github.com/modelcontextprotocol/ext-apps)                         | MCP Apps extension (embedded UIs)      |
| [ext-auth](https://github.com/modelcontextprotocol/ext-auth)                         | Authorization extensions               |
