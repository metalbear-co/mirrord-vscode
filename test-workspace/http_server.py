from http.server import BaseHTTPRequestHandler, HTTPServer

class HTTPRequestHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        print("GET: Request completed")
        self.send_response(200)
        self.send_header("Content-type", "application/json")
        self.send_header("Content-Length", len("GET"))
        self.end_headers()
        self.wfile.write("GET".encode('utf8'))

if __name__ == "__main__":
    server_address = ('0.0.0.0', 80)
    httpd = HTTPServer(server_address, HTTPRequestHandler)
    print("Local app started")
    httpd.serve_forever()
