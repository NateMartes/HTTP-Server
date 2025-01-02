import net from "node:net";

// headers and uri are Buffer as URI and header fields aren't guarantee to be ASCII or UTF-8 strings
type HTTPReq = {
    method: string,
    uri: Buffer,
    version: string,
    headers: Buffer[]
}

type HTTPRes = {
    code: number,
    headers: Buffer[],
    body: BodyReader
}

type BodyReader = {
    // -1 if unknow
    length: number,
    //payload is a promise as the response has not set maximum length
    read: () => Promise<Buffer>
}

//connection promise wrapper so we dont have to use callbacks
type TCPConn = {
    socket: net.Socket;
    err: null | Error;
    ended: boolean;

    //nth callbacks of the promise of the current read
    reader: null | {
        resolve: (value: Buffer) => void,
        reject: (reason: Error) => void,
    };
};

class HTTPError extends Error {
    public code: number;
    
    constructor(code: number, message: string) {
        super(message);
        this.name = "HTTPError"
        this.code = code;
    }
}

/*
 * soInit setups a TCPConn for a connection socket, setting up callback events aswell
 */
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

/*
 * soRead is a Promise wrapper for the data event
 */
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

/*
 * soWrite is a Promise wrapper for socket.write() 
 */
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

/*
 * TCPListener is used to wrap socket.listen() and the connection event
 */
type TCPListener = {
    socket: net.Server;
    host: String,
    port: String
}

/*
 * soListen is a Promise wrapper for the listening socket
 */
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

/*
 * soAccept is a wrapper for the connection event
 */
function soAccept(listener: TCPListener): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        listener.socket.on("connection", (socket: net.Socket) => resolve(socket));
        listener.socket.on("error", (err: Error) => reject(err));
    });
}

/*
 * DynBuf is a dynamic buffer to store incoming data
 */
type DynBuf = {
    data: Buffer;
    length: number;
}

/*
 * pushBuf pushes a new buffer onto an exisiting dynamic buffer
 */
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

/*
 * popBuf removes the lastest message from a dynamic buffer
 */
function popBuf(buf: DynBuf, len: number): void {
    const newBuffer = Buffer.alloc(buf.length - len);
    buf.data.copy(newBuffer, 0, len, buf.length);
    buf.data = newBuffer;
    buf.length -= len;
}

//max length of a HTTP header (8GB)
const maxHeaderLength = 1024 * 8;

/*
 * getMessage retrives a message from a dynamic buffer, returning null if a buffer doesnt contain a message
 */

function getMessage(buf: DynBuf): null | HTTPReq {
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

function splitLines(data: Buffer): Buffer[] {
    let lines:Buffer[] = [];
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
        //"Transfer-Encoding" field is a header
    }

    //read the rest of the connection
    return {length: 0, read: async (): Promise<Buffer> => {return Buffer.from('')}};
}

function fieldGet(headers: Buffer[], field: string): null | Buffer {
    let value = Buffer.alloc(0);
    headers.forEach((key: Buffer) => {
        if (key.toString().toLocaleLowerCase().indexOf(field.toLocaleLowerCase()) !== -1) {
            value = key.subarray(key.indexOf(':') + (key.indexOf(' ') === -1 ? 1 : 2), key.length);
        }
    });
    return value.length === 0 ? null : value;
}

function readerFromConnLength(conn: TCPConn, buf: DynBuf, payloadLength: number): BodyReader {
    return {
        length: payloadLength,
        read: async (): Promise<Buffer> => {
            if (payloadLength === 0) return Buffer.from('');
            console.log(buf.length);
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

async function handleReq(req: HTTPReq, body: BodyReader): Promise<HTTPRes> {
    let resp: BodyReader;
    switch (req.uri.toString('latin1')) {
       case '/echo':
            resp = body;
            break;
        default:
            resp = readerFromMemory(Buffer.from("Hello World!\n"));
            break;
    }
    
    return {
        code: 200,
        headers: [Buffer.from('Server: http_test_server')],
        body: resp,
    };
}

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

async function writeHTTPResp(conn: TCPConn, resp: HTTPRes, version: string): Promise<void> {
    if (resp.body.length < 0) {
        //chunked encoding    
    }
    
    console.assert(!fieldGet(resp.headers, 'Content-Length'));
    resp.headers.push(Buffer.from(`Content-Length: ${resp.body.length}`));

    //write header
    await soWrite(conn, encodeHTTPResp(resp, version));

    //write body
    while (true) {
        const data = await resp.body.read();
        console.log(`dataToWrite[${data.toString()}] length: ${data.length}`);
        if (data.length === 0) break;
        await soWrite(conn, data);
    }
}

function encodeHTTPResp(resp: HTTPRes, version: string): Buffer {
    let respString = (`${version} ${resp.code}\r\n`);
    resp.headers.forEach((h) => respString += `${h}\r\n`);
    respString += "\r\n";
    console.log(JSON.stringify(respString));
    return Buffer.from(respString);
    
}

async function serveClient(conn: TCPConn): Promise<void> {
    const buf: DynBuf = {data: Buffer.alloc(0), length: 0};
    while (true) {
        // Try to get an HTTP request
        const msg: null | HTTPReq = getMessage(buf);
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
        const reqBody: BodyReader = readFromReq(conn, buf, msg);
        const res: HTTPRes = await handleReq(msg, reqBody);
        await writeHTTPResp(conn, res, msg.version);
       
        if (msg.version === "HTTP/1.0") return;

        while ((await reqBody.read()).length > 0){}
    }
}

/*
 * newConn informs the server a new connection has been made, and serves the connection
 */
async function newConn(socket: net.Socket): Promise<void> {
    console.log(`new connection ${socket.remoteAddress}, ${socket.remotePort}`);
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

/*
 * listenForClient waits for a connection if not already connected
 */
async function listenForClient(socket: net.Server): Promise<void> {
    while (true) {
        try {
            const listener: TCPListener = soListen(socket, "127.0.0.1", "1234");
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
