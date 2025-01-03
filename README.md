# HTTP-Server
This is a HTTP Server built using NodeJs's .net library.
I built this server from scratch to understand the inner-workings of HTTP such as dynamic buffers, TCP connections and URI's.

## Building the Server
First, clone the repository using `git clone`:
`git clone https://github.com/NateMartes/HTTP-Server.git`

Then there are two approaches provided for building the server:
### 1. Using Docker [(Docker Documentation)](https://docs.docker.com/get-started/get-docker/)
Using Docker, build the Docker image using the provided Dockerfile (assuming in your the current repository):

`sudo docker build -t http-server:latest .`

Then run the container using:

`sudo docker run -dp {host-port}:1234 --name http_server http-server:latest`

### 2. Using NodeJS [(NodeJS Documentation)](https://nodejs.org/en/download)

Assuming yo have NodeJS install, you can run:

`npx tsx httpServer.ts`

**NOTE:** The Server using port 1234 by default. you can change this by altering the used port in `httpServer.ts`

## Testing the Server

Testing the server can be done using `curl`:

`curl http://0.0.0.0:1234`

which returns `Hello World!`.

Also the URI `/echo` returns the payload the client sends to the server

`curl --data-binary 'I'm Sending Data' http://0.0.0.0:1234/echo`

## Resources Used
[Build Your Own Web Server](https://build-your-own.org/webserver/): A “Build Your Own X” book that dives deep into the understanding of network programming, TCP, and HTTP.

[RFC 9112](https://www.rfc-editor.org/rfc/rfc9112.html): Request for comments 9112 for HTTP/1.1 to correctly parse HTTP request and correctly send HTTP responses.

[Node Js .net Library](https://nodejs.org/api/net.html): NodeJs's .net Library discussing the Socket class, and Server class

[Node Js Buffer Library](https://nodejs.org/api/buffer.html): NodeJs's .net Library discussing the Buffer class and server useful methods such as Buffer.alloc() and Buffer.copy()
