#!/usr/bin/env python
from http import server 
import sys

class MyHTTPRequestHandler(server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_my_headers()

        server.SimpleHTTPRequestHandler.end_headers(self)

    def send_my_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")

if __name__ == '__main__':
    print('Test server with COOP/COEP isolation headers')
    class MyServer(server.ThreadingHTTPServer):

        def finish_request(self, request, client_address):
            self.RequestHandlerClass(request, client_address, self,
                                        directory='build')

    bind = 'localhost'
    if len(sys.argv) > 1:
        bind = sys.argv[1]
    port = 8000
    if len(sys.argv) > 2:
        port = int(sys.argv[2])
    server.test(ServerClass=MyServer, HandlerClass=MyHTTPRequestHandler, bind=bind, port=port)