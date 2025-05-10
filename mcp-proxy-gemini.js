const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const CONFIG = {
    PORT: process.env.PORT || 9090,
    LLAMA_SERVER_URL: process.env.LLAMA_SERVER_URL || 'http://localhost:8080',
    MCP_CONFIG_PATH: process.env.MCP_CONFIG_PATH || path.join(__dirname, 'mcp-config.json'),
    LLAMA_SERVER_TIMEOUT: process.env.LLAMA_SERVER_TIMEOUT || 60000,
};

const mcpClients = {};
const mcpTools = [];

// function debugLogSSE(data) {
//     console.log("\n[DEBUG RAW SSE]:", JSON.stringify(data).substring(0, 200) + (data.length > 200 ? "..." : ""));
//   }

function readMcpConfig() {
    try {
        if (!fs.existsSync(CONFIG.MCP_CONFIG_PATH)) {
            console.error(`MCP config file not found at ${CONFIG.MCP_CONFIG_PATH}`);
            return {};
        }
        const configData = fs.readFileSync(CONFIG.MCP_CONFIG_PATH, 'utf8');
        const config = JSON.parse(configData);
        if (!config.mcpServers || typeof config.mcpServers !== 'object') {
            console.error('Invalid MCP config: mcpServers must be an object');
            return {};
        }
        return config.mcpServers;
    } catch (error) {
        console.error('Failed to read or parse MCP config:', error);
        return {};
    }
}

async function connectToServer(serverName, serverConfig) {
    try {
        const { command, args, env } = serverConfig;
        console.log(`Connecting to MCP server '${serverName}'...`);
        console.log(`Command: ${command} ${args.join(' ')}`);
        const processEnv = { ...process.env, ...(env || {}) };
        const transport = new StdioClientTransport({ command, args, env: processEnv });
        const client = new Client({ name: `mcp-proxy-${serverName}`, version: "1.0.0" });
        client.connect(transport);
        const toolsResult = await client.listTools();
        mcpClients[serverName] = { client, transport, tools: toolsResult.tools };
        const serverTools = toolsResult.tools.map(tool => ({ ...tool, server: serverName }));
        mcpTools.push(...serverTools);
        console.log(`Connected to MCP server '${serverName}' with tools:`, toolsResult.tools.map(t => t.name).join(', '));
        return client;
    } catch (error) {
        console.error(`Failed to connect to or get tools from MCP server '${serverName}':`, error);
        return null;
    }
}

async function initializeMcp() {
    const servers = readMcpConfig();
    console.log(`Found ${Object.keys(servers).length} MCP servers in configuration`);
    const connectionPromises = Object.entries(servers).map(([serverName, serverConfig]) =>
        connectToServer(serverName, serverConfig)
    );
    await Promise.all(connectionPromises);
    console.log(`Connected to ${Object.keys(mcpClients).length} MCP servers with ${mcpTools.length} total tools`);
}

function generateMcpSystemPrompt() {
    if (mcpTools.length === 0) {
        return '';
    }
    let prompt = 'You have access to the following tools via the Model Context Protocol:\n\n';
    const toolsByServer = {};
    mcpTools.forEach(tool => {
        toolsByServer[tool.server] = toolsByServer[tool.server] || [];
        toolsByServer[tool.server].push(tool);
    });
    Object.entries(toolsByServer).forEach(([server, tools]) => {
        prompt += `From server: ${server}\n\n`;
        tools.forEach(tool => {
            prompt += `${tool.name} - ${tool.description}\n\n`;
        });
    });
    prompt += 'When appropriate, use a tool call to access external information or perform actions.\n';
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
    return messages;
}

async function handleToolCall(toolCall) {
    try {
        const [serverName, toolName] = toolCall.name.includes('.') ? toolCall.name.split('.') : [null, toolCall.name];
        let client;
        if (serverName) {
            if (!mcpClients[serverName]) {
                throw new Error(`MCP client '${serverName}' not found`);
            }
            client = mcpClients[serverName].client;
        } else {
            const clientEntry = Object.entries(mcpClients).find(([, data]) => data.tools.some(t => t.name === toolName));
            if (!clientEntry) {
                throw new Error(`Tool '${toolName}' not found in any server`);
            }
            client = clientEntry[1].client;
        }

        console.log(`[Tool Call] Calling tool: ${toolName}, server: ${serverName || 'auto-selected'}, arguments:`, toolCall.input); // Detailed Log
        const result = await client.callTool({ name: toolName, arguments: toolCall.input });
        console.log(`[Tool Call] Tool call result for '${toolName}':`, result); // Log the tool result
        return result.content;
    } catch (error) {
        console.error('[Tool Call Error] Failed to handle tool call:', error);
        console.error('[Tool Call Error] Tool Call Details:', toolCall); // Log the failing tool call
        return `Error executing tool: ${error.message}`;
    }
}

function makeLlamaRequest(options, data) {
    return new Promise((resolve, reject) => {
        const protocol = options.protocol === 'https:' ? https : http;
        const req = protocol.request(options, (res) => {
            resolve({ statusCode: res.statusCode, headers: res.headers, res: res });
        });

        req.on('error', (error) => {
            reject(error);
        });

        req.setTimeout(CONFIG.LLAMA_SERVER_TIMEOUT, () => {
            req.destroy();
            reject(new Error(`Request to llama-server timed out after ${CONFIG.LLAMA_SERVER_TIMEOUT}ms`));
        });

        if (data) {
            req.write(data);
        }
        req.end();
    });
}

const server = http.createServer(async (req, res) => {
    try {
        if (req.method === 'POST' && req.url === '/v1/chat/completions') {
            let body = '';
            req.on('data', chunk => { body += chunk.toString(); });

            req.on('end', async () => {
                try {
                    let requestData = JSON.parse(body);
                    requestData.messages = enhanceSystemMessage(requestData.messages);

                    if (requestData.model && requestData.model.toLowerCase().includes('claude')) {
                        requestData.tools = mcpTools.map(tool => ({
                            name: tool.name,
                            description: tool.description,
                            input_schema: tool.inputSchema
                        }));
                    }

                    let modifiedRequestData = JSON.stringify(requestData);
                    let awaitingToolResponse = false;
                    let conversationMessages = requestData.messages; // Keep track of messages

                    const serverUrl = new URL(CONFIG.LLAMA_SERVER_URL);
                    let options = {
                        hostname: serverUrl.hostname,
                        port: serverUrl.port,
                        path: req.url,
                        method: req.method,
                        headers: { ...req.headers, 'Content-Length': Buffer.byteLength(modifiedRequestData) },
                        protocol: serverUrl.protocol
                    };

                    let buffer = '';
                    let firstResponse = true;

                    async function processLlamaResponse(llamaResponse, isContinuation = false) {
                        console.log(`[processLlamaResponse] Function entered. Status Code: ${llamaResponse.statusCode}, isContinuation: ${isContinuation}`);
                        
                        if (llamaResponse.statusCode !== 200) {
                            console.error(`[Llama Server Error] Status Code: ${llamaResponse.statusCode}`);
                            if (!isContinuation && !res.headersSent) {
                                res.writeHead(llamaResponse.statusCode, llamaResponse.headers);
                            }
                            llamaResponse.res.pipe(res);
                            return;
                        }
                        
                        // Only set headers on initial call, not on continuation
                        if (!isContinuation && !res.headersSent) {
                            res.writeHead(llamaResponse.statusCode, llamaResponse.headers);
                        }
                        
                        let accumulatedText = ''; // Accumulate entire response text
                        let responseSoFar = '';
                        let passthrough = true; // Initially pass everything through
                        let responseEnded = false; // Flag to track if response has ended
                        
                        // Helper function to safely write to response
                        const safeWrite = (data) => {
                            if (!responseEnded && !res.writableEnded && !res.destroyed) {
                                try {
                                    res.write(data);
                                } catch (writeError) {
                                    console.error("[Response Write Error]:", writeError.message);
                                    responseEnded = true;
                                }
                            }
                        };
                        
                        // Helper function to safely end response
                        const safeEnd = () => {
                            if (!responseEnded && !res.writableEnded && !res.destroyed) {
                                try {
                                    safeWrite(`data: [DONE]\n\n`);
                                    res.end();
                                    responseEnded = true;
                                    console.log("[Response Ended]");
                                } catch (endError) {
                                    console.error("[Response End Error]:", endError.message);
                                    responseEnded = true;
                                }
                            }
                        };
                        
                        try {
                            for await (const chunk of llamaResponse.res) {
                                if (responseEnded) break; // Skip processing if response already ended
                                
                                const chunkStr = chunk.toString();
                                //console.log("[DEBUG RAW SSE]:", JSON.stringify(chunkStr).substring(0, 200));
                                
                                try {
                                    // Parse the SSE data
                                    const lines = chunkStr.split('\n');
                                    for (const line of lines) {
                                        if (responseEnded) break; // Skip if response ended
                                        
                                        if (line.startsWith('data: ') && line.substring(6) !== '[DONE]') {
                                            const jsonData = JSON.parse(line.substring(6));
                                            
                                            if (jsonData.choices && jsonData.choices[0] && jsonData.choices[0].delta && jsonData.choices[0].delta.content) {
                                                const content = jsonData.choices[0].delta.content;
                                                accumulatedText += content;
                                                responseSoFar += content;
                                                
                                                // Check complete accumulated text for tool call pattern - UPDATED to support all tool names
                                                const toolCallMatch = accumulatedText.match(/```tool_code\s*\n*(\w+(?:_\w+)*)\(([^)]+)\)\s*\n*```/) || 
                                                                   accumulatedText.match(/(\w+(?:_\w+)*)\(([^)]+)\)/);
                                                
                                                if (toolCallMatch && passthrough) {
                                                    passthrough = false; // Stop passing through once we detect a tool call
                                                    console.log("[Tool Call Detected] Full pattern:", toolCallMatch[0]);
                                                    
                                                    const toolName = toolCallMatch[1]; // list_directory, brave_web_search, etc
                                                    const argsString = toolCallMatch[2]; // path="/Users/vmajor/Development/code"
                                                    
                                                    // Parse the arguments
                                                    const args = {};
                                                    const argMatches = argsString.matchAll(/(\w+)=["']?([^,"']+)["']?/g);
                                                    for (const argMatch of argMatches) {
                                                        args[argMatch[1]] = argMatch[2];
                                                    }
                                                    
                                                    console.log(`[Parsed Tool Call] Tool: ${toolName}, Args:`, args);
                                                    
                                                    // Execute the tool
                                                    const toolCall = {
                                                        id: `tool-${Date.now()}`,
                                                        name: toolName,
                                                        input: args
                                                    };
                                                    
                                                    // Send notice to client about tool execution
                                                    const toolStartMessage = {
                                                        id: jsonData.id,
                                                        choices: [{
                                                            index: 0,
                                                            delta: { content: `\n\n[Executing ${toolName}...]` },
                                                            finish_reason: null
                                                        }]
                                                    };
                                                    safeWrite(`data: ${JSON.stringify(toolStartMessage)}\n\n`);
                                                    
                                                    // Execute tool and get result
                                                    try {
                                                        const toolResult = await handleToolCall(toolCall);
                                                        console.log("[Tool Result]:", toolResult);
                                                        
                                                        if (responseEnded) return; // Check if response ended during tool execution
                                                        
                                                        // FORMAT THE TOOL RESULT PROPERLY
                                                        let formattedResult = '';
                                                        if (typeof toolResult === 'string') {
                                                            formattedResult = toolResult;
                                                        } else if (toolResult && toolResult.content) {
                                                            // Check if content is an array
                                                            if (Array.isArray(toolResult.content)) {
                                                                formattedResult = toolResult.content
                                                                    .map(item => {
                                                                        if (item.type === 'text') return item.text;
                                                                        return JSON.stringify(item);
                                                                    })
                                                                    .join('\n');
                                                            } else {
                                                                // If content is not an array but some other value
                                                                formattedResult = JSON.stringify(toolResult.content);
                                                            }
                                                        } else {
                                                            // Fallback if unexpected format
                                                            formattedResult = JSON.stringify(toolResult);
                                                        }
                                                        
                                                        // Add type and length debugging
                                                        console.log("[FULL FORMATTED RESULT TYPE]:", typeof formattedResult);
                                                        console.log("[FULL FORMATTED RESULT LENGTH]:", formattedResult.length);
                                                        if (typeof formattedResult === 'object') {
                                                            formattedResult = JSON.stringify(formattedResult, null, 2);
                                                        }
                                                        
                                                        // Log the full formatted result
                                                        console.log("[Formatted Tool Result]:", formattedResult);
                                                            
                                                        // CHANGED: Send the complete result to the client with code formatting
                                                        const toolResultMessage = {
                                                            id: jsonData.id,
                                                            choices: [{
                                                                index: 0,
                                                                delta: { 
                                                                    content: `\n\n[Tool Result]:\n\`\`\`\n${formattedResult}\n\`\`\`\n\n` 
                                                                },
                                                                finish_reason: null
                                                            }]
                                                        };
                                                        safeWrite(`data: ${JSON.stringify(toolResultMessage)}\n\n`);
                                                        
                                                        if (responseEnded) return; // Exit if response ended
                                                        
                                                        // REPLACEMENT: Instead of continuation, just inform the user
                                                        try {
                                                            const resultInfoMessage = {
                                                                id: jsonData.id || "result-info",
                                                                choices: [{
                                                                    index: 0,
                                                                    delta: { 
                                                                        content: `\n\nHere's what I found. You can ask follow-up questions about this information.` 
                                                                    },
                                                                    finish_reason: "stop"
                                                                }]
                                                            };
                                                            safeWrite(`data: ${JSON.stringify(resultInfoMessage)}\n\n`);
                                                            safeEnd();
                                                            
                                                            // Skip continuation request entirely
                                                            console.log("[Skipping continuation to avoid cancellation]");
                                                            return;
                                                        } catch (error) {
                                                            console.error("[Result Info Error]:", error);
                                                            safeEnd();
                                                        }
                                                        
                                                        return;
                                                    } catch (toolError) {
                                                        console.error("[Tool Execution Error]:", toolError);
                                                        // Inform client about error
                                                        const errorMessage = {
                                                            id: jsonData.id,
                                                            choices: [{
                                                                index: 0,
                                                                delta: { content: `\n\nError executing tool: ${toolError.message}` },
                                                                finish_reason: "stop"
                                                            }]
                                                        };
                                                        safeWrite(`data: ${JSON.stringify(errorMessage)}\n\n`);
                                                        safeEnd();
                                                        return;
                                                    }
                                                }
                                            }
                                        } else if (line.startsWith('data: ') && line.substring(6) === '[DONE]') {
                                            // Forward [DONE] event if we're still in passthrough mode
                                            if (passthrough) {
                                                safeWrite(line + '\n');
                                                safeEnd();
                                            }
                                        }
                                        
                                        // Pass through the line if we're still in passthrough mode
                                        if (passthrough && line.trim() !== '') {
                                            safeWrite(line + '\n');
                                        }
                                    }
                                } catch (parseError) {
                                    console.error("[Parsing Error]:", parseError, "in chunk:", chunkStr);
                                    // In case of error, pass through the original chunk
                                    if (passthrough) {
                                        safeWrite(chunkStr);
                                    }
                                }
                            }
                            
                            // If we finish without finding a tool call, make sure to end the response
                            if (passthrough && !responseEnded) {
                                console.log("[No Tool Call Detected] Ending response normally");
                                safeEnd();
                            }
                        } catch (streamError) {
                            console.error("[Stream Processing Error]:", streamError);
                            if (!responseEnded) {
                                safeEnd();
                            }
                        }
                    }

                    console.log("[Initial Request] Sending initial request to llama-server.");
                    const initialLlamaResponse = await makeLlamaRequest(options, modifiedRequestData);
                    await processLlamaResponse(initialLlamaResponse);


                } catch (error) {
                    console.error('[Chat Completion Error] Error processing chat completion:', error);
                    res.statusCode = 500;
                    res.end(JSON.stringify({ error: 'Internal Server Error', message: error.message }));
                }
            });

        } else {
            // Proxy other requests
            const serverUrl = new URL(CONFIG.LLAMA_SERVER_URL);
            const options = {
                hostname: serverUrl.hostname,
                port: serverUrl.port,
                path: req.url,
                method: req.method,
                headers: req.headers,
                protocol: serverUrl.protocol
            };

            const proxyReq = (serverUrl.protocol === 'https:' ? https : http).request(options, (proxyRes) => {
                res.writeHead(proxyRes.statusCode, proxyRes.headers);
                proxyRes.pipe(res);
            });

            proxyReq.on('error', (error) => {
                console.error('[Proxy Request Error] Proxy request error:', error);
                res.statusCode = 500;
                res.end(JSON.stringify({ error: 'Proxy Error', message: error.message }));
            });
            req.pipe(proxyReq);
        }
    } catch (error) {
        console.error('[Unhandled Request Error] Unhandled error in request handling:', error);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'Internal Server Error', message: error.message }));
    }
});

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
            if (mcpTools.length > 0) {
                console.log(`Available MCP tools: ${mcpTools.length}`);
                console.log('\nSystem prompt that will be added:');
                console.log('--------------------------------');
                console.log(generateMcpSystemPrompt());
                console.log('--------------------------------\n');
            } else {
                console.log('\nNo MCP tools available - no system prompt will be added.\n');
            }
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
})();

process.on('SIGINT', () => {
    console.log('Shutting down MCP proxy server...');
    cleanup();
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
process.on('SIGTERM', () => {
    console.log('Shutting down MCP proxy server (SIGTERM)...');
    cleanup();
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    cleanup();
    process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    cleanup();
    process.exit(1);
});