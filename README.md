# About this repository

This repository is a fork '[extopico/llama-server_mcp_proxy](https://github.com/extopico/llama-server_mcp_proxy)'. 
Some modification was done in toolcalling format.
Following llm models are working 
- Qwen3-30B-A3B
- Jan-v1-4B
- Qwen3-8B
- deepseek-r1-distill-qwen-32b

llama-server doesnot support more than one `<think> </think> ` . Some changes have to be done in llama.cpp source code for llama-server.

## Additional changes done in llama.cpp -server

### For version b6431

Replace following files
- replace file  'llama.cpp/tools/server/webui/src/components/ChatMessage.tsx'
- replace file 'llama.cpp/tools/server/public/index.html.gz'


### For version b6527

Replace following files
- replace file  'llama.cpp/tools/server/webui/src/lib/services/chat.ts'
- replace file 'llama.cpp/tools/server/public/index.html.gz'

Files are given in this repository (in folder 'Files replaced in llama.cpp' )

And then recompile llama-server

# Llama-Server MCP Proxy

This Node.js application acts as a proxy server for `llama-server`. Its primary purpose is to intercept chat completion requests, enhance them with tool capabilities via the Model Context Protocol (MCP), and allow the Language Model (LLM) to use these tools iteratively.

It proxies standard `llama-server` GUI requests (like fetching the main page) directly to your local `llama-server` instance and specifically processes `/v1/chat/completions` requests to enable tool interactions.

## Current status

* brave search works
* search1 API works
* filesystem access is problematic, depending on the model used
* puppeteer


## Key Features

*   **MCP Tool Integration:** Connects to MCP-compatible tool servers defined in `mcp-config.json`.
*   **Dynamic System Prompt:** Automatically generates a system prompt listing available tools and their descriptions, injecting it into the LLM's context.
*   **Iterative Tool Use:** Allows the LLM to make multiple tool calls in a single user turn. The proxy handles the request-response flow:
    1.  LLM indicates a tool call.
    2.  Proxy detects and parses the tool call.
    3.  Proxy executes the tool via the appropriate MCP client.
    4.  Proxy sends the tool's result back to the LLM.
    5.  LLM uses the result to continue its response or call another tool.
*   **Streaming Support:** Maintains streaming of LLM responses (Server-Sent Events) to the client, including intermediate messages like "[Executing tool...]" and tool results.
*   **Error Handling:** Forwards errors from `llama-server` and provides error messages for failed tool executions back to the LLM and client. The LLM will analyze the error and attempt to find a workable approach.
*   **Configurable:** Uses environment variables for port, `llama-server` URL, and MCP configuration path.
*   **Debug Logging:** Optional verbose debug logging via an environment variable.

## Prerequisites

*   **Node.js:** Version 18 or higher (as indicated by `@modelcontextprotocol/sdk` dependencies).
*   **`llama-server`:** A running instance of `llama-server` (or a compatible OpenAI-like API endpoint).
*   **MCP Tool Servers:** One or more MCP-compatible tool servers that you want the LLM to access.

## Setup

1.  **Clone the Repository (or create the project directory):**
    ```bash
    # If you have a git repository:
    # git clone <your-repo-url>
    # cd llama-server_mcp_proxy

    # If starting from scratch, create a directory and navigate into it:
    mkdir llama-server_mcp_proxy
    cd llama-server_mcp_proxy
    ```

2.  **Create `package.json`:**
    If you don't have one, create a `package.json` file with the following content:
    ```json
    {
      "name": "llama-server-mcp-proxy",
      "version": "1.0.0",
      "description": "A proxy for llama-server to enable MCP tool usage.",
      "main": "llama-server-mcp-proxy.js", 
      "scripts": {
        "start": "node llama-server-mcp-proxy.js"
      },
      "dependencies": {
        "@modelcontextprotocol/sdk": "^1.8.0"
      }
    }
    ```

3.  **Install Dependencies:**
    Run the following command in your project directory to install the necessary packages:
    ```bash
    npm install
    ```
    This will use your `package.json` (and `package-lock.json` if present and consistent) to install the `@modelcontextprotocol/sdk`.

4.  **Create `mcp-config.json`:**
    This file tells the proxy how to connect to your MCP tool servers. It should be in the same directory as your proxy script (e.g., `llama-server-mcp-proxy.js`) by default, or you can specify its path via the `MCP_CONFIG_PATH` environment variable.

    As a ready quick-start example rename  `mcp-config.json.example` to `mcp-config.json`

    **`mcp-config.json.example`:**
    ```json
    {
      "mcpServers": {
        "search1api": {
          "command": "npx",
          "args": [
            "search1api-mcp",
            "--port",
            "0", 
            "--api-key",
            "YOUR_SEARCH1API_KEY_PLACEHOLDER" 
          ],
          "env": {
            "DEBUG": "true" 
          }
        },
        "another_tool_server": {
          "command": "path/to/your/tool/server/executable",
          "args": [
            "--some-config-for-tool", "value",
            "--api-key", "ANOTHER_API_KEY_PLACEHOLDER"
          ],
          "env": {}
        }
      }
    }
    ```
    *   **`mcpServers`**: An object where each key is a unique name for your tool server (e.g., "search1api", "my_custom_tools").
    *   **`command`**: The command to execute to start the MCP tool server. This could be `npx` for npx-runnable packages, a direct path to an executable, or a script.
    *   **`args`**: An array of arguments to pass to the command.
        *   `--port 0` is often used to let the MCP server pick an available port for stdio communication.
        *   **Replace `YOUR_SEARCH1API_KEY_PLACEHOLDER` and other placeholders with your actual API keys or necessary configuration.**
    *   **`env`**: An optional object of environment variables to set for the MCP server process.

    **Create your actual `mcp-config.json` by copying the example and filling in your real API keys and paths.**

5.  **Add `mcp-config.json` to `.gitignore`:**
    To prevent accidentally committing your sensitive API keys, create or update your `.gitignore` file in the project root:
    ```
    node_modules/
    mcp-config.json
    *.log
    # Add other files/directories you want to ignore
    ```

6.  **Save the Proxy Code:**
    Save the JavaScript proxy code provided in the previous steps into a file, for example, `llama-server-mcp-proxy.js` (as referenced in `package.json`).

## Running the Proxy

1.  **Ensure `llama-server` is running.**
    The proxy needs to connect to it. By default, it assumes `llama-server` is at `http://localhost:8080`.

2.  **Start the Proxy Server:**
    Open your terminal in the project directory and run:
    ```bash
    npm start
    ```
    Or directly using Node:
    ```bash
    node llama-server-mcp-proxy.js
    ```

    You should see console output indicating the proxy has started, which MCP servers it connected to, and the tools available.

3.  **Configure Environment Variables (Optional):**
    You can customize the proxy's behavior using environment variables:
    *   `PORT`: The port the proxy server will listen on (default: `9090`).
    *   `LLAMA_SERVER_URL`: The URL of your running `llama-server` instance (default: `http://localhost:8080`).
    *   `MCP_CONFIG_PATH`: The full path to your `mcp-config.json` file (default: `./mcp-config.json` relative to the script).
    *   `MCP_PROXY_DEBUG`: Set to `true` for verbose debug logging (default: `false`).
    *   `LLAMA_SERVER_TIMEOUT`: Timeout in milliseconds for requests to `llama-server` (default: `60000`).

    Example (Linux/macOS):
    ```bash
    PORT=9000 LLAMA_SERVER_URL=http://127.0.0.1:8081 MCP_PROXY_DEBUG=true node llama-server-mcp-proxy.js
    ```
    Example (Windows PowerShell):
    ```powershell
    $env:PORT="9000"; $env:LLAMA_SERVER_URL="http://127.0.0.1:8081"; $env:MCP_PROXY_DEBUG="true"; node llama-server-mcp-proxy.js
    ```

## Usage

1.  Once the proxy server is running, **point your LLM GUI client (e.g., your browser accessing a web UI that normally talks to `llama-server`) to the proxy's address and port** (e.g., `http://localhost:9090` if the proxy is running on port 9090).
2.  Interact with the LLM as usual.
3.  When you ask the LLM to perform a task that could benefit from one of the configured tools, it should:
    *   Indicate its intention to use a tool.
    *   Output a tool call in the format `TOOL_NAME(ARG_NAME="ARG_VALUE", ...)` or potentially an XML format.
4.  The proxy will:
    *   Detect this tool call.
    *   Show an "[Executing tool: TOOL_NAME...]" message in the stream.
    *   Execute the tool.
    *   Show a "[Tool Result for TOOL_NAME]: ...RAW_RESULT..." message in the stream.
    *   Feed the result back to the LLM.
5.  The LLM will then use the tool's result to formulate its final response or decide to call another tool.

## Tool Call Formats Recognized

The proxy attempts to recognize tool calls in the LLM's output in two primary formats after the LLM finishes its current response segment (indicated by `[DONE]`):

1.  **Function Style:**
    ```
    {
        "type": "tool_call",
         "name": "getCurrentTime",
          "parameters": { "arg1": "arg1 value", "arg2" : "arg2 value".. }
    }
    ```


   

The proxy will parse the arguments accordingly for each format.

## Troubleshooting

*   **"Tool ... not found in any connected MCP server"**:
    *   Ensure the tool name output by the LLM exactly matches a tool name listed when the proxy starts (which comes from your MCP servers).
    *   Check your `mcp-config.json` for typos in tool server commands or configurations.
    *   Verify that your MCP tool servers are starting correctly and successfully registering their tools. Check the console output of the proxy when it starts for connection messages.
*   **Proxy errors / `llama-server` errors (500, 502, etc.)**:
    *   Ensure `llama-server` is running and accessible at the `LLAMA_SERVER_URL`.
    *   Check `llama-server`'s own logs for any issues.
    *   Enable `MCP_PROXY_DEBUG=true` for more detailed logs from the proxy.
*   **Tool execution errors (e.g., "402 Payment Required")**: These errors come from the MCP tool server itself. The proxy will report them to the LLM, which should then ideally try a different approach or inform you.
*   **"Socket hang up" / `ECONNRESET`**: This can occur if `llama-server` closes the connection unexpectedly. This might happen if the proxy sends a malformed request (e.g., incorrect JSON structure, problematic headers) or if `llama-server` itself encounters an internal error. Debug logs from both the proxy and `llama-server` are crucial.

## Dependencies

*   `@modelcontextprotocol/sdk`: Version `^1.8.0` (and its transitive dependencies as listed in `package-lock.json`).

---
