export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const pathAndQuery = url.pathname + url.search;
		
		// Check if this is a WebSocket request
		if (request.headers.get("Upgrade") === "websocket") {
			return this.handleWebSocket(request, pathAndQuery, ctx);
		} else {
			// Handle HTTP request
			return this.handleHTTP(request, pathAndQuery);
		}
	},

	async handleWebSocket(request, pathAndQuery, ctx) {
		const targetUrl = `wss://generativelanguage.googleapis.com${pathAndQuery}`;
		console.log('Target WebSocket URL:', targetUrl);

		const [client, proxy] = new WebSocketPair();
		proxy.accept();

		// 用于存储在连接建立前收到的消息
		let pendingMessages = [];
		let isConnected = false;

		const connectPromise = new Promise((resolve, reject) => {
			let targetWebSocket;
			
			try {
				targetWebSocket = new WebSocket(targetUrl);
				console.log('Initial targetWebSocket readyState:', targetWebSocket.readyState);
				
				// Set a connection timeout
				const connectionTimeout = setTimeout(() => {
					if (!isConnected) {
						const error = new Error('Connection to Gemini API timed out');
						console.error(error);
						if (proxy.readyState === WebSocket.OPEN) {
							proxy.send(JSON.stringify({
								error: {
									message: error.message
								}
							}));
							proxy.close(1011, 'Connection timeout');
						}
						reject(error);
					}
				}, 15000); // 15 seconds timeout
				
				targetWebSocket.addEventListener("open", () => {
					console.log('Connected to target server');
					console.log('targetWebSocket readyState after open:', targetWebSocket.readyState);
					isConnected = true;
					clearTimeout(connectionTimeout);
					
					// 连接建立后，发送所有待处理的消息
					console.log(`Processing ${pendingMessages.length} pending messages`);
					for (const message of pendingMessages) {
						try {
							targetWebSocket.send(message);
							console.log('Sent pending message:', typeof message === 'string' ? message.slice(0, 100) : 'Binary data');
						} catch (error) {
							console.error('Error sending pending message:', error);
							proxy.send(JSON.stringify({
								error: {
									message: `Failed to send message: ${error.message}`
								}
							}));
						}
					}
					pendingMessages = []; // 清空待处理队列
					resolve(targetWebSocket);
				});

				proxy.addEventListener("message", async (event) => {
					console.log('Received message from client:', {
						dataPreview: typeof event.data === 'string' ? event.data.slice(0, 200) : 'Binary data',
						dataType: typeof event.data,
						timestamp: new Date().toISOString()
					});
					
					if (targetWebSocket.readyState === WebSocket.OPEN) {
						try {
							targetWebSocket.send(event.data);
							console.log('Successfully sent message to gemini');
						} catch (error) {
							console.error('Error sending to gemini:', error);
							proxy.send(JSON.stringify({
								error: {
									message: `Failed to send message to Gemini: ${error.message}`
								}
							}));
						}
					} else {
						// 如果连接还未建立，将消息加入待处理队列
						console.log('Connection not ready, queueing message');
						pendingMessages.push(event.data);
					}
				});

				targetWebSocket.addEventListener("message", (event) => {
					console.log('Received message from gemini:', {
						dataPreview: typeof event.data === 'string' ? event.data.slice(0, 200) : 'Binary data',
						dataType: typeof event.data,
						timestamp: new Date().toISOString()
					});
					
					try {
						if (proxy.readyState === WebSocket.OPEN) {
							// 直接转发消息，不尝试解析或验证
							// 让客户端处理解析逻辑
							proxy.send(event.data);
							console.log('Successfully forwarded message to client');
						}
					} catch (error) {
						console.error('Error forwarding to client:', error);
						// Try to notify client about the error
						if (proxy.readyState === WebSocket.OPEN) {
							try {
								proxy.send(JSON.stringify({
									error: {
										message: `Error processing Gemini response: ${error.message}`
									}
								}));
							} catch (notifyError) {
								console.error('Failed to notify client about error:', notifyError);
							}
						}
					}
				});

				targetWebSocket.addEventListener("close", (event) => {
					console.log('Gemini connection closed:', {
						code: event.code,
						reason: event.reason || 'No reason provided',
						wasClean: event.wasClean,
						timestamp: new Date().toISOString(),
						readyState: targetWebSocket.readyState
					});
					if (proxy.readyState === WebSocket.OPEN) {
						proxy.close(event.code, event.reason);
					}
				});

				proxy.addEventListener("close", (event) => {
					console.log('Client connection closed:', {
						code: event.code,
						reason: event.reason || 'No reason provided',
						wasClean: event.wasClean,
						timestamp: new Date().toISOString()
					});
					if (targetWebSocket.readyState === WebSocket.OPEN) {
						targetWebSocket.close(event.code, event.reason);
					}
				});

				targetWebSocket.addEventListener("error", (error) => {
					console.error('Gemini WebSocket error:', {
						error: error.message || 'Unknown error',
						timestamp: new Date().toISOString(),
						readyState: targetWebSocket.readyState
					});
					
					// Notify client about the error
					if (proxy.readyState === WebSocket.OPEN) {
						try {
							proxy.send(JSON.stringify({
								error: {
									message: `Gemini WebSocket error: ${error.message || 'Unknown error'}`
								}
							}));
						} catch (notifyError) {
							console.error('Failed to notify client about WebSocket error:', notifyError);
						}
					}
					
					reject(error);
				});
				
			} catch (error) {
				console.error('Error setting up WebSocket connection:', error);
				if (proxy.readyState === WebSocket.OPEN) {
					proxy.send(JSON.stringify({
						error: {
							message: `Failed to establish connection: ${error.message}`
						}
					}));
					proxy.close(1011, error.message);
				}
				reject(error);
			}
		});

		ctx.waitUntil(connectPromise.catch(error => {
			console.error('WebSocket connection promise rejected:', error);
		}));

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	},

	async handleHTTP(request, pathAndQuery) {
		const targetUrl = `https://generativelanguage.googleapis.com${pathAndQuery}`;
		console.log('Target HTTP URL:', targetUrl);

		// Clone the request headers
		const headers = new Headers(request.headers);
		
		// Create a new request to forward to the Gemini API
		const newRequest = new Request(targetUrl, {
			method: request.method,
			headers: headers,
			body: request.body,
			redirect: 'follow',
		});

		try {
			// Forward the request to the Gemini API
			const response = await fetch(newRequest);
			
			// Clone the response headers
			const responseHeaders = new Headers(response.headers);
			
			// 直接返回响应，不尝试解析或验证JSON
			// 让客户端处理解析逻辑
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers: responseHeaders,
			});
		} catch (error) {
			console.error('Error proxying HTTP request:', error);
			return new Response(JSON.stringify({
				error: {
					message: `Error proxying request: ${error.message}`,
					details: error.stack
				}
			}), {
				status: 500,
				headers: {
					'Content-Type': 'application/json'
				}
			});
		}
	}
};
