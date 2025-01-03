/*
 * Author: Nathaniel Martes
 * Description:
 *  Creates a TCP server reading HTTP requests, also know as an HTTP server.
 *  Uri Descriptions:
 *
 *    - /     : writes "Hello World!\n" back to the client.
 *    - /echo : writes the payload from the client back to the client.
 *              if there is no payload, no payload is sent to the client.
 */

import net from "node:net";

// HTTPReq encapsulates a HTTP request into object fields.
type HTTPReq = {
    method: string,
    version: string,
    
    // uri and headers are type Buffer because URIs and header fields aren't gauranteed to be 
    // ASCII or UTF-8 strings.
    uri: Buffer,
    headers: Buffer[]
}

// HTTPRes encapsulates a HTTP response into object fields.
type HTTPRes = {
    code: number,
    headers: Buffer[],
    body: BodyReader
}

// Body Reader encapsulates a HTTP response payload.
type BodyReader = {
    // -1 if unknow.
    length: number,
    //payload is a promise as the response has not set maximum length.
    read: () => Promise<Buffer>
}

// HTTPError is used for easy error throwing in the event of a bad request.
class HTTPError extends Error {
    public code: number;
    
    constructor(code: number, message: string) {
        super(message);
        this.name = "HTTPError"
        this.code = code;
    }
}

// DynBuf is a dynamic buffer to store incoming data so we can build
// a protocal to decide what a request is.
type DynBuf = {
    data: Buffer;
    length: number;
}

// pushBuf pushes a new buffer onto an exisiting dynamic buffer.
function pushBuf(buf: DynBuf, data: Buffer): void {
    const newLen = buf.length + data.length;
    if (newLen > buf.data.length) {
        let cap = buf.data.length;
        while (cap < newLen) {
            cap = cap * 2 + 1 
        }
        const newBuffer = Buffer.alloc(cap);
        buf.data.copy(newBuffer, newBuffer.length, buf.data.length);
        buf.data = newBuffer;
    }

    data.copy(buf.data, buf.length, 0);
    buf.length = newLen;
}

// popBuf removes the lastest message from a dynamic buffer.
function popBuf(buf: DynBuf, len: number): void {
    const newBuffer = Buffer.alloc(buf.length - len);
    buf.data.copy(newBuffer, 0, len, buf.length);
    buf.data = newBuffer;
    buf.length -= len;
}

// TCPConn encapsulates net.Socket so we can use Promise & async/await instead of callbacks.
type TCPConn = {
    socket: net.Socket;
    err: null | Error;
    ended: boolean;

    //nth callbacks of the promise of the current read.
    reader: null | {
        resolve: (value: Buffer) => void,
        reject: (reason: Error) => void,
    };
};

// soInit setups a TCPConn for a connection socket, setting up callback events aswell.
function soInit(socket: net.Socket): TCPConn {
    const conn: TCPConn = {
        socket: socket, err: null, ended: false, reader: null,
    };

    socket.on('data', (data: Buffer) => {

        //pause the 'data' event until this current read is over
        conn.socket.pause();

        //fulfill the promise of the current read
        conn.reader!.resolve(data);

        //read is over
        conn.reader = null;
    });

    socket.on('end', () => {
        conn.ended = true;
        if (conn.reader) {
            conn.reader.resolve(Buffer.from(''));
            conn.reader = null;
        }
    });

    socket.on('error', (err: Error) => {
        conn.err = err;
        if (conn.reader) {
            conn.reader.reject(err);
            conn.reader = null;
        }
    });

    return conn;
}

// soRead is a Promise wrapper for the data event.
function soRead(conn: TCPConn): Promise<Buffer> { 
    console.assert(!conn.reader);
    return new Promise((resolve, reject) => {
        
        if (conn.err) {
            reject(conn.err);
            return;
        }
        if (conn.ended) {
            resolve(Buffer.from(''));
            return;
        }
        conn.reader = {resolve: resolve, reject: reject};
        conn.socket.resume();
    });
}

// soWrite is a Promise wrapper for socket.write(). 
function soWrite(conn: TCPConn, data: Buffer): Promise<void> {
    console.assert(data.length > 0);
    return new Promise((resolve, reject) => {
        if (conn.err) {
            reject(conn.err);
            return;
        }

        conn.socket.write(data, (err? : Error) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

// TCPListener is used to wrap socket.listen() and the connection event.
type TCPListener = {
    socket: net.Server;
    host: String,
    port: String
}

// soListen is a Promise wrapper for the listening socket.
function soListen(socket: net.Server, hostAddress: String, portAddress: String): TCPListener {
    const listener: TCPListener = {
        socket: socket,
        host: hostAddress,
        port: portAddress,
    };

    if (!socket.listening) {
        socket.listen({
            host: hostAddress,
            port: portAddress
        }, () => {
            console.log(`Server running on ${hostAddress}:${portAddress}`);
        });
    } else {
        console.log(`Server still listening on ${hostAddress}:${portAddress}`);
    }

    return listener;
}

// soAccept is a wrapper for the connection event.
function soAccept(listener: TCPListener): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        listener.socket.on("connection", (socket: net.Socket) => resolve(socket));
        listener.socket.on("error", (err: Error) => reject(err));
    });
}

/*
 * NOTE:
 * HTTP requests and responses are determined and created based off of RFC (Request for Comments) 9112, HTTP/1.1
 * to view more about RFC 9112, please refer to https://www.rfc-editor.org/rfc/rfc9112.html
 */
    
// max length of a HTTP header (8GB).
const maxHeaderLength = 1024 * 8;

// getMessage retrives a message from a dynamic buffer, returning null if a buffer doesnt contain a message.
function getHTTPHeader(buf: DynBuf): null | HTTPReq {
    //end of header is marked by '\r\n\r\n'
    if (buf.length === 0) return null;
    const index = buf.data.subarray(0, buf.length).indexOf('\r\n\r\n');
    if (index < 0) {
        if (buf.length >= maxHeaderLength) throw new HTTPError(413, 'header is too large');
        return null; //more data is needed
    }
    const msg: HTTPReq = parseHTTPReq(buf.data.subarray(0, index + 4));
    popBuf(buf, index + 4);
    return msg;
}

// parseHTTPReq takes a buffer contaning a HTTP request and removes the HTTP header.
function parseHTTPReq(data: Buffer): HTTPReq {
    const lines = splitLines(data);
    const [method, uri, version] = parseRequestLine(lines[0]);
    const headers: Buffer[] = [];
    
    for (let i = 1; i < lines.length - 1; i++) {
        let h: Buffer = lines[i];
        if (!checkHeaderLine(h)) throw new HTTPError(400, 'bad field');
    
        //remove trailling whitespace if exists
        h = Buffer.from(h.toString().trim());
        headers.push(h);
    }
    
    console.assert(lines[lines.length - 1].length === 0);
    return { method: method, uri: uri, version: version, headers: headers, };
}

// splitLines takes Buffer an splits it into an aray of Buffers using \r\n as the delimiter.
function splitLines(data: Buffer): Buffer[] {
    let lines: Buffer[] = [];
    const delimiter = Buffer.from('\r\n');
    let start = 0
    let index = data.indexOf(delimiter, start);
    while (index !== -1) {
        lines.push(data.subarray(start, index));
        start = index + delimiter.length;
        index = data.indexOf(delimiter, start);
    }

    return lines;
}

// parseRequestLine takes a buffer and extracts the HTTP request line's parts.
function parseRequestLine(data: Buffer): [string, Buffer, string] {
    const delimiter = Buffer.from(' ');
    let start = 0;

    let index = data.indexOf(delimiter, start);
    const method = data.subarray(start, index).toString();
    start = index + 1;
    
    index = data.indexOf(delimiter, start);
    const uri = data.subarray(start, index);
    start = index + 1

    const version = data.subarray(start).toString();
    if (!version.match("^HTTP\/[0-9]\.[0-9]$")) throw new HTTPError(400, 'bad request line.');

    return [method, uri, version];
}

// checkHeaderLine ensures a HTTP header line follows the RFC.
function checkHeaderLine(data: Buffer): boolean {
    const colon = data.indexOf(':');
    if (colon === -1) return false;
    const firstOWS = data.indexOf(' ');
    if (firstOWS === -1) return true;
    if (firstOWS < colon) return false;
    const secondOWS = data.indexOf(' ', firstOWS + 1);
    if (secondOWS === -1) return true;
    if (firstOWS + 1 === secondOWS) return false;
    return true;
}

// readFromReq reads the payload from a HTTP request.
function readFromReq(conn: TCPConn, buf: DynBuf, req: HTTPReq): BodyReader {
    let payloadLength = -1;
    const contentLength: null | Buffer = fieldGet(req.headers, 'Content-Length');
    if (contentLength) {
        payloadLength = Number(contentLength.toString('latin1'));
        if (isNaN(payloadLength)) throw new HTTPError(400, 'bad Content-Length.');
    }
    const bodyAllowed: boolean = !(req.method === 'GET' || req.method === 'HEAD');
    const chunked: null | Buffer = fieldGet(req.headers, 'Transfer-Encoding');
    const isChunked: boolean = chunked?.equals(Buffer.from('chunked')) || false;
    
    if (!bodyAllowed && (payloadLength > 0 || isChunked)) {
        throw new HTTPError(400, 'HTTP body not allowed.');
    }
    
    if (!bodyAllowed) payloadLength = 0;
    
    if (payloadLength >= 0) {

        //"Content-Length" field is a header
        return readerFromConnLength(conn, buf, payloadLength);

    } else if (isChunked) {
    
        // TODO: "Transfer-Encoding" field is a header
        throw new HTTPError(501, "TODO: Transfer-Encoding");
    }

    // TODO: read the rest of the connection
    throw new HTTPError(501, "TODO: reading rest of connection");
}

// fieldGet gets a field from a HTTP header (case-insensistive).
function fieldGet(headers: Buffer[], field: string): null | Buffer {
    let value = Buffer.alloc(0);
    headers.forEach((key: Buffer) => {
        if (key.toString().toLocaleLowerCase().indexOf(field.toLocaleLowerCase()) !== -1) {
            value = key.subarray(key.indexOf(':') + (key.indexOf(' ') === -1 ? 1 : 2), key.length);
        }
    });
    return value.length === 0 ? null : value;
}

// readerFromConnLength reads the payload from a HTTP request an reads it using Content-Length.
function readerFromConnLength(conn: TCPConn, buf: DynBuf, payloadLength: number): BodyReader {
    return {
        length: payloadLength,
        read: async (): Promise<Buffer> => {
            if (payloadLength === 0) return Buffer.from('');
            if (buf.length === 0) {
                const data = await soRead(conn);
                pushBuf(buf, data);
                if (data.length === 0) {
                    //More data was expected
                    throw new Error('Unexpected EOF from HTTP body.');
                }
            }
            
            const consume = Math.min(buf.length, payloadLength);
            payloadLength -= consume;
            const data = Buffer.from(buf.data.subarray(0, consume));
            popBuf(buf, consume);
            return data;
        },
    };
}

// handleReq takes a HTTP request an determines what to respond with
async function handleReq(req: HTTPReq, body: BodyReader): Promise<HTTPRes> {
    let resp: BodyReader;
    switch (req.uri.toString('latin1')) {
       case '/echo':
            // returns the payload from the client
            resp = body;
            break;
        default:
            // default payload
            resp = readerFromMemory(Buffer.from("Hello World!\n"));
            break;
    }
    
    return {
        code: 200,
        headers: [Buffer.from('Server: http_test_server')],
        body: resp,
    };
}

// readerFromMemory creates a default BodyReader, with the payload being the passed in Buffer.
function readerFromMemory(data: Buffer): BodyReader {
    let done = false;
    return {
        length: data.length,
        read: async (): Promise<Buffer> => {
            if (done) return Buffer.from('');
            done = true;
            return data;
        }
    };
}

// writeHTTPResp writes a HTTP response containing the correct payload.
async function writeHTTPResp(conn: TCPConn, resp: HTTPRes, version: string): Promise<void> {
    if (resp.body.length < 0) {
        // TODO: chunked encoding    
    }
    
    console.assert(!fieldGet(resp.headers, 'Content-Length'));
    resp.headers.push(Buffer.from(`Content-Length: ${resp.body.length}`));

    //write header
    await soWrite(conn, encodeHTTPResp(resp, version));

    //write body
    while (true) {
        const data = await resp.body.read();
        if (data.length === 0) break;
        await soWrite(conn, data);
    }
}

// encodeHTTPResp prepares the response's header before sending it to the client
function encodeHTTPResp(resp: HTTPRes, version: string): Buffer {
    let respString = (`${version} ${resp.code}\r\n`);
    resp.headers.forEach((h) => respString += `${h}\r\n`);
    respString += "\r\n";
    return Buffer.from(respString);
    
}

// serveClient takes a TCP connection socket and serves it based on the HTTP request provided
async function serveClient(conn: TCPConn): Promise<void> {
    const buf: DynBuf = {data: Buffer.alloc(0), length: 0};
    while (true) {
        // Try to get an HTTP request
        const msg: null | HTTPReq = getHTTPHeader(buf);
        if (!msg) {
            const data = await soRead(conn);
            pushBuf(buf, data);
        
            if (data.length === 0 && buf.length === 0) {
                return;
            }

            if (data.length === 0) {
                throw new HTTPError(400, "Unexpected EOF.");
            }

            continue;
        }
        
        console.log(`Handling Request from ${conn.socket.remoteAddress}:${conn.socket.remotePort}`)
        const reqBody: BodyReader = readFromReq(conn, buf, msg);
        const res: HTTPRes = await handleReq(msg, reqBody);
        await writeHTTPResp(conn, res, msg.version);
       
        if (msg.version === "HTTP/1.0") return;

        while ((await reqBody.read()).length > 0){}
    }
}

// newConn informs the server a new connection has been made, and serves the connection.
async function newConn(socket: net.Socket): Promise<void> {
    console.log(`New connection from ${socket.remoteAddress}:${socket.remotePort}`);
    try {
        await serveClient(soInit(socket));
    } catch (exc) {
        console.error(`exception: ${exc}`);
        if (exc instanceof HTTPError) {
            const resp: HTTPRes = {
                code: exc.code,
                headers: [],
                body: readerFromMemory(Buffer.from(exc.message + '\n')),
            };
            try {
                await writeHTTPResp(soInit(socket), resp, "1.0");
            } catch (exc) { /* ignore */ }
        }
    } finally {
        socket.destroy();
    }
}

// listenForClient waits for a connection if not already connected.
async function listenForClient(socket: net.Server): Promise<void> {
    while (true) {
        try {
            const listener: TCPListener = soListen(socket, "0.0.0.0", "1234");
            const connSocket: net.Socket = await soAccept(listener);
            await newConn(connSocket);
        } catch (exc) {
            console.error(`exception: ${exc}`);
            break;
        }
         
    }
}

const server = net.createServer({
    pauseOnConnect: true,
});

listenForClient(server);
