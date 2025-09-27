// --- START OF FULL MODIFIED CODE ---

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

// --- Basic Logging ---
const log = {
    info: (...args) => console.log('[INFO]', ...args),
    warn: (...args) => console.warn('[WARN]', ...args),
    error: (...args) => console.error('[ERROR]', ...args),
    // Simple debug toggle based on env var
    debug: (...args) => { if (process.env.MCP_PROXY_DEBUG === 'true') console.debug('[DEBUG]', ...args); }
};

// --- Configuration ---
const CONFIG = {
    PORT: process.env.PORT || 9090,
    LLAMA_SERVER_URL: process.env.LLAMA_SERVER_URL || 'http://localhost:8080',
    MCP_CONFIG_PATH: process.env.MCP_CONFIG_PATH || path.join(__dirname, 'mcp-config.json'),
    MAX_TOOL_LOOPS: 5, // Prevent infinite tool loops
};

// --- Globals ---
const mcpClients = {};
const mcpTools = [];

// --- MCP Initialization (Keep Original Logging) ---
function readMcpConfig() {
    try {
        if (!fs.existsSync(CONFIG.MCP_CONFIG_PATH)) {
            console.error(`MCP config file not found at ${CONFIG.MCP_CONFIG_PATH}`); // Keep original console.error
            return {};
        }
        const configData = fs.readFileSync(CONFIG.MCP_CONFIG_PATH, 'utf8');
        const config = JSON.parse(configData);
        if (!config.mcpServers || typeof config.mcpServers !== 'object') {
            console.error('Invalid MCP config: mcpServers must be an object'); // Keep original console.error
            return {};
        }
        return config.mcpServers;
    } catch (error) {
        console.error('Failed to read or parse MCP config:', error); // Keep original console.error
        return {};
    }
}

async function connectToServer(serverName, serverConfig) {
    try {
        const { command, args, env } = serverConfig;
        console.log(`Connecting to MCP server '${serverName}'...`); // Keep original console.log
        console.log(`Command: ${command} ${args.join(' ')}`); // Keep original console.log
        const processEnv = { ...process.env, ...(env || {}) };
        const transport = new StdioClientTransport({ command, args, env: processEnv });
        const client = new Client({ name: `mcp-proxy-${serverName}`, version: "1.0.0" });
        await client.connect(transport);
        const toolsResult = await client.listTools();
         if (!toolsResult || !Array.isArray(toolsResult.tools)) { // Basic validation
             throw new Error(`Invalid tools response from server '${serverName}'`);
         }
        mcpClients[serverName] = { client, transport, tools: toolsResult.tools };
        const serverTools = toolsResult.tools.map(tool => ({ ...tool, server: serverName }));
        mcpTools.push(...serverTools);
        console.log(`Connected to MCP server '${serverName}' with tools:`, toolsResult.tools.map(t => t.name).join(', ')); // Keep original console.log
        return client;
    } catch (error) {
        console.error(`Failed to connect to or get tools from MCP server '${serverName}':`, error); // Keep original console.error
        return null;
    }
}

async function initializeMcp() {
    const servers = readMcpConfig();
    console.log(`Found ${Object.keys(servers).length} MCP servers in configuration`); // Keep original console.log
    const connectionPromises = Object.entries(servers).map(([serverName, serverConfig]) =>
        connectToServer(serverName, serverConfig)
    );
    await Promise.all(connectionPromises);
    console.log(`Connected to ${Object.keys(mcpClients).length} MCP servers with ${mcpTools.length} total tools`); // Keep original console.log
}

// --- Prompt Generation (Keep Original) ---
function generateMcpSystemPrompt() {
    if (mcpTools.length === 0) {
        return '';
    }
    let prompt = "You are a helpful AI assistant. Your primary goal is to assist users with their questions and tasks to the best of your abilities.\nWhen responding:\n- Answer directly from your knowledge when you can\n- Be concise, clear, and helpful\n- Admit when you’re unsure rather than making things up\n\mIf tools are available to you,  always  use tools\n\nWhen using tools:\n- Use one tool at a time and wait for results\n- Use actual values as arguments, not variable names\n- Learn from each result before deciding next steps\n\nYou have access to the following tools via the Model Context Protocol:\n";

    const toolsByServer = {};
    mcpTools.forEach(tool => {
        toolsByServer[tool.server] = toolsByServer[tool.server] || [];
        toolsByServer[tool.server].push(tool);
    });
    Object.entries(toolsByServer).forEach(([server, tools]) => {
        prompt += `# From server: ${server}\n\n`;
        tools.forEach(tool => {
            prompt += `${tool.name} - ${tool.description}\n`;

            //also including parameter details
            if (tool.inputSchema && tool.inputSchema.properties) {
                prompt += `Parameters:`;
                if(tool.inputSchema.properties==undefined || Object.keys(tool.inputSchema.properties).length==0){
                    prompt += `(no Parameters)`;
                }
                prompt += `\n`;

                for (const paramName in tool.inputSchema.properties) {
                    const paramDetails = tool.inputSchema.properties[paramName];
                    prompt += `  - ${paramName}`
                    if (tool.inputSchema.required.includes(paramName)){
                        prompt += ` (required)`;
                    }
                    prompt += `: Type=${paramDetails.type}`
                    if(paramDetails.description!=undefined){
                        prompt += `, Description=${paramDetails.description}`;
                    }
                    prompt += `\n`;
                }
            }

            prompt += `\n`;
        });
    });
    // Original instruction format that worked for detection
       prompt += 'When appropriate, use a tool call to access external information or perform actions by responding with the call tool)\n Tool call format is\n{\n"type":"tool_call",\n"name":"<toolname>",\n"parameters":{\n"<arg1 name>":"<arg1 value>",\n"<arg2 name>" : "<arg2 value>" <..and so on>\n}\n}';

    return prompt;
}

function enhanceSystemMessage(messages) {
    const mcpPrompt = generateMcpSystemPrompt();
    if (!mcpPrompt) {
        return messages;
    }
    let systemMsg = messages.find(msg => msg.role === 'system');
    if (systemMsg) {
        systemMsg.content = `${mcpPrompt}\n\n${systemMsg.content}`;
    } else {
        messages.unshift({ role: 'system', content: mcpPrompt });
    }
    log.debug("System prompt added/enhanced.");
    return messages;
}

// --- Tool Handling (Keep Original + Minor Result Formatting Helper) ---
function formatToolResultToString(result) {
    let resultString = '';
     if (!result) { // MCP result might be null/undefined if tool had no output
         resultString = "[Tool executed successfully but returned no content]";
     } else if (typeof result === 'string') {
        resultString = result;
    } else if (Array.isArray(result)) {
        // Handle array content, often from text extraction tools
        resultString = result
            .map(item => {
                if (typeof item === 'string') return item;
                if (item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string') return item.text;
                return JSON.stringify(item); // Fallback for unknown array items
            })
            .join('\n\n'); // Join blocks with double newline
    } else if (typeof result === 'object' && result.content !== undefined) {
        // Handle the common { content: ... } pattern
         // Recursively format the inner content if needed, or handle common types
         if (typeof result.content === 'string') {
             resultString = result.content;
         } else if (Array.isArray(result.content)) {
             resultString = formatToolResultToString(result.content); // Recurse for arrays within content
         } else {
              resultString = JSON.stringify(result.content);
         }
    }
     else {
        // Fallback for other object types
        resultString = JSON.stringify(result, null, 2);
    }
    return resultString;
}


async function handleToolCall(toolCall) { // toolCall = { id, name, input }
    // Use original logging style
    console.log(`[Tool Call] Calling tool: ${toolCall.name}, server: auto-selected, arguments:`, toolCall.input);
    try {
        // Find client (keep original logic)
        const [serverNameExplicit, toolNameOnly] = toolCall.name.includes('.') ? toolCall.name.split('.', 2) : [null, toolCall.name];
        let client;
        let targetServerName = serverNameExplicit;
        let targetToolName = toolNameOnly;

        if (serverNameExplicit) {
            if (!mcpClients[serverNameExplicit]) {
                throw new Error(`MCP client server '${serverNameExplicit}' specified in tool name not found`);
            }
             const toolExists = mcpClients[serverNameExplicit].tools.some(t => t.name === toolNameOnly);
             if (!toolExists) {
                  throw new Error(`Tool '${toolNameOnly}' not found in specified server '${serverNameExplicit}'`);
             }
            client = mcpClients[serverNameExplicit].client;
        } else {
            const clientEntry = Object.entries(mcpClients).find(([, data]) => data.tools.some(t => t.name === toolNameOnly));
            if (!clientEntry) {
                throw new Error(`Tool '${toolNameOnly}' not found in any connected MCP server`);
            }
            [targetServerName, { client }] = clientEntry; // Get server name and client
             console.log(`[Tool Call] Auto-selected server '${targetServerName}' for tool '${toolNameOnly}'`);
        }

        // Execute
        const result = await client.callTool({ name: targetToolName, arguments: toolCall.input });
        console.log(`[Tool Call] Raw result from MCP tool '${targetToolName}':`, result);

        // Format result to string using helper
        const resultString = formatToolResultToString(result); // Use the helper
        log.info(`Formatted tool result string length: ${resultString.length}`);
        log.debug("Formatted Tool Result String (first 500):", resultString.substring(0,500));

        return resultString; // Return the formatted string

    } catch (error) {
        console.error('[Tool Call Error] Failed to handle/execute tool call:', error); // Keep original console.error
        console.error('[Tool Call Error] Original Tool Call Details:', toolCall); // Keep original console.error
        return `Error executing tool ${toolCall.name}: ${error.message}`; // Return error string
    }
}

// --- HTTP Request Helper (Keep Original) ---
function makeLlamaRequest(options, data) {
    return new Promise((resolve, reject) => {
        log.debug("Making LLM request with options:", options);
        log.debug("LLM request data (first 500):", data ? data.substring(0, 500) : "N/A");
        const protocol = options.protocol === 'https:' ? https : http;
        const req = protocol.request(options, (res) => {
            log.info(`LLM server responded: ${res.statusCode}`);
            resolve({ statusCode: res.statusCode, headers: res.headers, res: res });
        });

        req.on('error', (error) => {
            log.error(`LLM request error: ${error.message}`);
            reject(error);
        });

        if (data) {
            req.write(data);
        }
        req.end();
    });
}

// --- Safe Write/End Helpers (Keep Original Style) ---
const safeWrite = (res, data) => {
    if (!res.writableEnded && !res.destroyed) {
        try {
            res.write(data);
            return true;
        } catch (writeError) {
            console.error("[Response Write Error]:", writeError.message); // Keep original console.error
            if (!res.writableEnded) res.end(); // Attempt to close gracefully
            return false;
        }
    }
    log.warn("Attempted write to ended/destroyed stream.");
    return false;
};

const safeEnd = (res) => {
    if (!res.writableEnded && !res.destroyed) {
        try {
            res.end();
            log.debug("Response ended safely.");
            return true;
        } catch (endError) {
            console.error("[Response End Error]:", endError.message); // Keep original console.error
            return false;
        }
    }
    log.warn("Attempted end on already ended/destroyed stream.");
    return false;
};


// --- Main Server Logic (Modified for Loop) ---
const server = http.createServer(async (req, res) => {
    log.info(`Incoming request: ${req.method} ${req.url}`);

    // --- Proxy non-chat requests directly ---
    if (!(req.method === 'POST' && req.url === '/v1/chat/completions')) {
        try {
            const serverUrl = new URL(CONFIG.LLAMA_SERVER_URL);
            log.info(`Proxying non-chat request: ${req.method} ${req.url} to ${CONFIG.LLAMA_SERVER_URL}`); // Changed log message

            // Determine Content-Length and Content-Type for non-chat requests
            let contentLength = '0'; // Default for GET, DELETE, HEAD
            let contentType = req.headers['content-type']; // Use original if present

            if (req.method === 'POST' || req.method === 'PUT') { // For methods that can have a body
                if (req.headers['content-length']) {
                    contentLength = req.headers['content-length'];
                } else {
                    // If no content-length, it might be chunked or the client didn't send it.
                    // llama-server might require it or handle chunked encoding.
                    // For simplicity, if it's not a GET/HEAD/DELETE and no length, remove it
                    // and let Node's http.request handle it (e.g. if piping a body).
                    
                    log.warn(`Non-chat ${req.method} request without 'content-length' header. Proxying as is.`);
                }
            } else { // For GET, HEAD, DELETE, etc.
                contentType = undefined; // Typically no Content-Type for GET/HEAD/DELETE requests with no body
            }


            const proxyRequestOptions = { // Renamed 'options' to avoid conflict if 'options' is used later
                hostname: serverUrl.hostname,
                port: serverUrl.port,
                path: req.url,
                method: req.method,
                headers: {
                    // Forward most headers from the original request
                    ...req.headers,
                    // Override/set specific headers for the proxy request
                    'Host': serverUrl.host, // Crucial: set Host to the target server
                    'Content-Length': contentLength, // Set calculated or original content length
                    'User-Agent': 'mcp-proxy', // Set your proxy's user agent
                    // Remove or ensure proper handling of connection-specific headers
                    'connection': undefined, // Let Node manage the connection
                    'upgrade': undefined,
                    // 'accept-encoding': undefined, // Optional: request plain response if llama-server gzipping is an issue
                },
                protocol: serverUrl.protocol
            };

            if (contentType) {
                proxyRequestOptions.headers['Content-Type'] = contentType;
            } else {
                delete proxyRequestOptions.headers['content-type']; // Remove if not applicable
            }
            
            // Clean up any headers that became undefined
            Object.keys(proxyRequestOptions.headers).forEach(key => {
                if (proxyRequestOptions.headers[key] === undefined) {
                    delete proxyRequestOptions.headers[key];
                }
            });

            log.info(`Proxying non-chat request with headers:`, proxyRequestOptions.headers); // Corrected log message

            const proxyReq = (serverUrl.protocol === 'https:' ? https : http).request(proxyRequestOptions, (proxyRes) => {
                log.info(`Proxy response for non-chat request ${req.url}: ${proxyRes.statusCode}`);
                // Forward headers from proxyRes to client, excluding problematic ones
                const clientResHeaders = { ...proxyRes.headers };
                delete clientResHeaders['transfer-encoding']; // Let Node handle client-side chunking if needed
                delete clientResHeaders['connection'];       // Hop-by-hop header
             
                res.writeHead(proxyRes.statusCode, clientResHeaders);
                proxyRes.pipe(res, { end: true });
            });

            proxyReq.on('error', (error) => {
                console.error('[Proxy Request Error - Non-Chat] Proxy request error:', error);
                if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
                // Use safeEnd if it's defined in this scope, otherwise res.end
                if (!res.writableEnded) res.end(JSON.stringify({ error: 'Proxy Error', message: error.message }));
            });

            // Timeout for non-chat requests (ensure CONFIG.LLAMA_SERVER_TIMEOUT is defined or use a default)
            const timeoutDuration = typeof CONFIG.LLAMA_SERVER_TIMEOUT === 'number' ? CONFIG.LLAMA_SERVER_TIMEOUT : 30000; // Default 30s
            if (timeoutDuration > 0) {
                proxyReq.setTimeout(timeoutDuration, () => {
                    proxyReq.destroy(new Error('Proxy request for non-chat endpoint timed out'));
                    log.warn(`Proxy request for non-chat ${req.url} timed out`);
                    if (!res.headersSent && !res.writableEnded) {
                        res.writeHead(504, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Proxy Timeout' }));
                    } else if (!res.writableEnded) {
                        res.end();
                    }
                });
            }

            // Pipe the original request body (if any) to the proxy request
            // For GET/HEAD, req is a readable stream but will end immediately without data, which is fine.
            req.pipe(proxyReq, { end: true });

        } catch (error) {
            console.error('[Proxy Error - Non-Chat] Error handling non-chat request:', error);
             if (!res.headersSent && !res.writableEnded) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
             }
             // Use safeEnd if it's defined in this scope, otherwise res.end
             if (!res.writableEnded) res.end(JSON.stringify({ error: 'Internal Server Error', message: error.message }));
        }
        return; // Stop processing here for non-chat requests
    }

    // --- Handle Chat Completions (Modified Logic) ---
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });

    req.on('end', async () => {
        let requestData;
        let conversationMessages;
        let clientResponseSentHeaders = false;
        let loopCount = 0;
        let continueLoop = true;

        try {
            requestData = JSON.parse(body);
            log.debug("Initial request body parsed:", requestData);

            // Enhance system prompt (original function)
            conversationMessages = enhanceSystemMessage(requestData.messages || []);

            // --- Main Interaction Loop ---
            while (continueLoop && loopCount < CONFIG.MAX_TOOL_LOOPS) {
                loopCount++;
                log.info(`--- Starting Interaction Loop #${loopCount} ---`);
                continueLoop = false; // Assume loop stops unless a tool call happens

                // Prepare request data for this loop iteration
                // Keep original request parameters, but use current messages
                const currentPayload = {
                     ...requestData, // Spread original request params (temp, top_k etc.)
                    messages: conversationMessages, // Use potentially updated messages
                    stream: true // Ensure stream is requested
                    // Avoid sending 'tools' if llama-server ignores/dislikes it
                    // delete currentPayload.tools;
                };
                const currentRequestDataString = JSON.stringify(currentPayload);

                // Use original method for setting request options
                const serverUrl = new URL(CONFIG.LLAMA_SERVER_URL);
                const options = {
                    hostname: serverUrl.hostname,
                    port: serverUrl.port,
                    path: '/v1/chat/completions', // Always target chat endpoint
                    method: 'POST', // Always POST for chat
                    // Mimic original header forwarding + Content-Length update
                    // IMPORTANT: Filter potentially problematic headers from original req.headers?

                    headers: {
                        ...req.headers, // Forward headers from original client request
                        'host': serverUrl.host, // Set correct host for target server
                        'content-length': Buffer.byteLength(currentRequestDataString), // Set correct length
                        // Ensure required headers if not forwarded
                        'content-type': 'application/json',
                        'accept': 'text/event-stream', // Explicitly request SSE
                    },
                    protocol: serverUrl.protocol
                };
                // Remove potential problematic headers forwarded from client
                delete options.headers['accept-encoding'];
                delete options.headers['connection'];


                let llamaResponse;
                try {
                    llamaResponse = await makeLlamaRequest(options, currentRequestDataString);
                } catch (llmReqError) {
                    log.error(`Loop #${loopCount}: LLM request failed: ${llmReqError.message}`);
                    if (!clientResponseSentHeaders && !res.writableEnded) {
                        res.writeHead(502, { 'Content-Type': 'application/json' });
                    }
                    if (!res.writableEnded) {
                        safeWrite(res, JSON.stringify({ error: { message: `Proxy failed to connect to LLM: ${llmReqError.message}`, type: 'proxy_error' } }));
                        safeEnd(res);
                    }
                    return; // Stop processing
                }

                // Handle LLM server errors (e.g., 500, 4xx)
                if (llamaResponse.statusCode !== 200) {
                    log.error(`Loop #${loopCount}: LLM server returned status ${llamaResponse.statusCode}`);
                    if (!clientResponseSentHeaders && !res.writableEnded) {
                        // Forward error status and headers if possible
                        const headersToForward = { ...llamaResponse.headers };
                        // Ensure content type if missing
                        if (!headersToForward['content-type']) {
                             headersToForward['content-type'] = 'application/json';
                        }
                        res.writeHead(llamaResponse.statusCode, headersToForward);
                        clientResponseSentHeaders = true;
                    }
                    // Pipe the error body through to the client
                    llamaResponse.res.pipe(res, { end: true });
                    return; // Stop processing
                }

                // --- Process SSE Stream ---
                // Send 200 OK headers to client ONCE
                if (!clientResponseSentHeaders && !res.writableEnded) {
                    log.info("Sending 200 OK stream headers to client.");
                     // Send minimal necessary headers for SSE
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream; charset=utf-8',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive',
                        // Add CORS if needed 'Access-Control-Allow-Origin': '*',
                    });
                    clientResponseSentHeaders = true;
                }

                let accumulatedAssistantContent = '';
                let detectedToolCall = null;
                let streamEndedNormally = false;
                let responseEndedWithError = false;

                try {
                    for await (const chunk of llamaResponse.res) {
                         if (res.writableEnded || res.destroyed) {
                            log.warn("Client connection closed during streaming.");
                            responseEndedWithError = true;
                            break; // Stop processing chunks
                         }

                        const chunkStr = chunk.toString('utf-8');
                        log.debug("[RAW SSE CHUNK]:", chunkStr.substring(0, 200)); // Less verbose debug

                        const lines = chunkStr.split('\n');
                        for (const line of lines) {
                             if (res.writableEnded || res.destroyed || responseEndedWithError) break;
                            if (line.trim() === '') continue;

                            log.debug("Processing SSE line:", line);

                            if (line.startsWith('data: ')) {
                                const dataContent = line.substring(6).trim();

                                if (dataContent === '[DONE]') {
                                    log.info("LLM stream ended normally ([DONE] received).");
                                    streamEndedNormally = true;
                                    break; // Stop processing lines in this chunk
                                }

                                try {
                                    const jsonData = JSON.parse(dataContent);
                                    const delta = jsonData?.choices?.[0]?.delta;
                                    const finishReason = jsonData?.choices?.[0]?.finish_reason; // Check finish reason
                                    if (!detectedToolCall) {
		                            if (!safeWrite(res, line + '\n')) {
		                                responseEndedWithError = true; // Stop if write fails
		                                log.warn("safeWrite: write fails")
		                                break;
		                            }
                                        
                                    }

                                    if (delta?.content) {
                                        accumulatedAssistantContent += delta.content;

                                        // Use original regex for tool detection
                                        //const toolCallMatch = accumulatedAssistantContent.match(/(\w+(?:_\w+)*)\(([^)]*)\)/); // Simpler regex used in original

                                        //tool calling format of Qwen3-30B-A3B-Q6_K
                                        ////////////////////////////////////////
                                        //{
                                        //"type": "tool_call",
                                        //"name": "getCurrentTime",
                                        //"parameters": {}
                                        //}
                                        ///////////////////////////////
                                        const toolCallMatch = accumulatedAssistantContent.match(/(\{\s*"type"\s*:\s*"tool_call",\s*("tool"|"tool_name"|"name")\s*:\s*"([^"]+)"(,\s*"parameters"\s*:\s*\{([\s\S]*?)\s*\})?\s*\})/);
                                        //log.info("accumulatedAssistantContent: " ,accumulatedAssistantContent)
                                        if (toolCallMatch && !detectedToolCall) {
                                            // The best and most reliable way to handle JSON in JavaScript is to parse it.
                                            log.info("[Tool Call Detected] Pattern:", toolCallMatch[0]);
                                            const data = JSON.parse(toolCallMatch[0]);
                                            // Extract the tool_name
                                            let toolName = data.tool;
                                            if(!toolName) {
                                                toolName = data.tool_name;
                                            }
                                            if(!toolName) {
                                                toolName = data.name;
                                            }
                                            // Extract the parameters object
                                            let parameters = data.parameters;



                                            // Parse args (use original simple parser)
                                            //const toolName = toolCallMatch[1];
                                            //const argsString = parameters 
                                            const args = {};
                                            if(parameters){
                                                // Loop through the parameters and add them to our object
                                                for (const key in parameters) {
                                                    if (Object.hasOwnProperty.call(parameters, key)) {
                                                        args[key] = parameters[key];
                                                    }
                                                }
                                            }
                                            log.info(`[Parsed Tool Call] Tool: ${toolName}, Args:`, args);

                                            detectedToolCall = {
                                                id: `tool-${jsonData.id || Date.now()}`, // Use message ID or timestamp
                                                name: toolName,
                                                input: args
                                            };

                                            // Optional: Send "executing" message to client
                                            const toolStartMsg = { id: jsonData.id, choices: [{ index: 0, delta: { content: `\n\n[Executing tool: ${toolName}...]` } }] };
                                            safeWrite(res, `data: ${JSON.stringify(toolStartMsg)}\n\n`);

                                            break; // Stop processing lines, prepare for tool execution
                                        }
                                    }

                                     // Check finish reason - if 'tool_calls' or similar, handle it (though unlikely with text-based detection)
                                     if (finishReason && finishReason !== 'stop' && finishReason !== 'length') {
                                         log.warn(`Unexpected finish_reason '${finishReason}' received. Treating as potential early stop.`);
                                         // If the model indicates tool calls via finish_reason, we might need different logic
                                         // For now, just log and continue as if it stopped.
                                         // streamEndedNormally = true;
                                         // break;
                                     }


                                    // --- Forward chunk to client IF no tool call detected yet ---


                                } catch (parseError) {
                                    log.warn("Failed to parse SSE JSON data:", parseError, "Line:", dataContent);
                                     // Forward raw line if passthrough? Maybe not safe.
                                }
                            } else {
                                // Forward non-data lines (comments, keepalives) if no tool detected
                                if (!detectedToolCall) {
                                    if (!safeWrite(res, line + '\n')) {
                                        responseEndedWithError = true;
                                        break;
                                    }
                                }
                            }
                        } // end line processing loop

                        if (detectedToolCall || streamEndedNormally || responseEndedWithError) {
                            break; // Exit chunk processing loop
                        }
                    } // end chunk processing loop

                    // --- After Stream Segment ---
                    if (responseEndedWithError) {
                         log.warn("Loop ending due to client disconnection or write error.");
                         continueLoop = false; // Stop outer loop
                    }
                    else if (detectedToolCall) {
                        log.info(`Executing detected tool call: ${detectedToolCall.name}`);
                        try {
                            const toolResultString = await handleToolCall(detectedToolCall);
                            if (toolResultString.length<200){
                                const toolresult= { id: `tool_limit_${Date.now()}`, choices: [{ index: 0, delta: { content: `\n\n[Tool Call] Result from MCP tool  : ${toolResultString.substring(0, 200)}...] \n\n` } }] };
                                safeWrite(res, `data: ${JSON.stringify(toolresult)}\n\n`);
                            }

                            // Append assistant message (partial response before tool call)
                            conversationMessages.push({
                                role: 'assistant',
                                content: accumulatedAssistantContent // Store what LLM generated
                            });
                            // Append tool result message
                            conversationMessages.push({
                                role: 'tool', // Standard role for tool results
                                tool_call_id: detectedToolCall.id, // Reference the call
                                name: detectedToolCall.name,
                                content: toolResultString
                            });
                            log.info("Appended assistant and tool messages to history.");
                            log.debug("Messages for next loop:", conversationMessages.slice(-2));
                            continueLoop = true; // Signal to continue the while loop

                        } catch (toolExecError) {
                             log.error("Error executing tool or formatting result:", toolExecError);
                             // Append assistant message and an error message for the tool
                             conversationMessages.push({ role: 'assistant', content: accumulatedAssistantContent });
                             conversationMessages.push({ role: 'tool', tool_call_id: detectedToolCall.id, name: detectedToolCall.name, content: `Execution failed: ${toolExecError.message}` });
                             log.warn("Appended error tool message. Continuing loop to let LLM know about the error.");
                             continueLoop = true; // Let LLM see the error
                        }
                    } else if (streamEndedNormally) {
                        log.info("Stream finished normally without tool call. Ending.");
                        if (!safeWrite(res, 'data: [DONE]\n\n')) { // Forward the final [DONE]
                            log.warn("Failed to write final [DONE] event to client.");
                        }
                        safeEnd(res);
                        continueLoop = false; // Stop outer loop
                    } else {
                        // Stream ended unexpectedly without explicit [DONE]
                        log.warn("LLM stream ended unexpectedly without [DONE].");
                        safeEnd(res); // Attempt to end client stream
                        continueLoop = false; // Stop outer loop
                    }

                } catch (streamError) {
                     log.error(`Loop #${loopCount}: Error processing LLM stream:`, streamError);
                     if (!res.writableEnded) safeEnd(res); // End client stream on error
                     continueLoop = false; // Stop outer loop
                }

            } // --- End of while loop ---

            if (loopCount >= CONFIG.MAX_TOOL_LOOPS) {
                log.warn(`Reached maximum tool interaction limit (${CONFIG.MAX_TOOL_LOOPS}). Stopping.`);
                if (!res.writableEnded) {
                    const limitMsg = { id: `tool_limit_${Date.now()}`, choices: [{ index: 0, delta: { content: `\n\n[Reached maximum tool interaction limit (${CONFIG.MAX_TOOL_LOOPS})]` }, finish_reason: 'length' }] };
                    safeWrite(res, `data: ${JSON.stringify(limitMsg)}\n\n`);
                    safeWrite(res, 'data: [DONE]\n\n');
                    safeEnd(res);
                }
            }

            log.info("Finished processing chat request.");

        } catch (error) {
            // Error parsing initial request body or other setup errors
            console.error('[Chat Completion Error] Error processing chat completion:', error); // Keep original console.error
            if (!clientResponseSentHeaders && !res.writableEnded) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
            }
            if (!res.writableEnded) {
                safeWrite(res, JSON.stringify({ error: 'Internal Server Error', message: error.message }));
                safeEnd(res);
            }
        }
    }); // end req.on('end')
}); // end http.createServer


// --- Cleanup and Startup (Keep Original) ---
function cleanup() {
    console.log('Cleaning up MCP clients...');
    for (const [name, clientData] of Object.entries(mcpClients)) {
        try {
            console.log(`Closing MCP client '${name}'...`);
            clientData.client.close();
        } catch (error) {
            console.error(`Error closing MCP client '${name}':`, error);
        }
    }
}

(async () => {
    try {
        await initializeMcp();
        server.listen(CONFIG.PORT, () => {
            console.log(`MCP proxy server running on port ${CONFIG.PORT}`);
            console.log(`Forwarding requests to llama-server at ${CONFIG.LLAMA_SERVER_URL}`);
            console.log(`Using MCP config from ${CONFIG.MCP_CONFIG_PATH}`);
            console.log(`Debug logging is ${process.env.MCP_PROXY_DEBUG === 'true' ? 'ENABLED' : 'DISABLED'} (set MCP_PROXY_DEBUG=true to enable)`);
            if (mcpTools.length > 0) {
                console.log(`Available MCP tools: ${mcpTools.length}`);
                console.log('\nSystem prompt that will be added:');
                console.log('--------------------------------');
                console.log(generateMcpSystemPrompt()); // Use console.log for multi-line
                console.log('--------------------------------\n');
            } else {
                console.log('\nNo MCP tools available - no system prompt will be added.\n');
            }
        });
        server.on('error', (error) => {
            console.error('Server error:', error);
             process.exit(1);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
})();

// --- Signal Handling (Keep Original) ---
const shutdown = (signal) => {
    log.info(`Received ${signal}. Shutting down gracefully...`);
    cleanup();
    server.close((err) => {
        if (err) {
            log.error('Error closing server:', err);
            process.exit(1);
        } else {
            log.info('Server closed. Exiting.');
            process.exit(0);
        }
    });
    setTimeout(() => {
        log.warn('Graceful shutdown timed out. Forcing exit.');
        process.exit(1);
    }, 10000);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM')); //comment this if you want to run this in the background after closing the terminal
process.on('uncaughtException', (err, origin) => {
    console.error(`Uncaught Exception at: ${origin}`, err); // Keep original console.error
    cleanup();
    process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason); // Keep original console.error
    // Consider if exit is needed: cleanup(); process.exit(1);
});

// --- END OF FULL MODIFIED CODE ---
