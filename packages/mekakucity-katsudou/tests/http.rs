use socket2::Socket;
use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

struct Server {
    child: Child,
    address: SocketAddr,
}

impl Server {
    fn spawn() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("reserve a free port");
        let address = listener.local_addr().expect("read the free port");
        drop(listener);

        let bundle =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/counter/dist/counter.iife.js");
        assert!(bundle.is_file(), "counter fixture bundle is missing");
        let child = Command::new(env!("CARGO_BIN_EXE_katsudou"))
            .args(["--listen", &address.to_string(), "--app"])
            .arg(format!("demo={}", bundle.display()))
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("start katsudou");
        let mut server = Self { child, address };
        let deadline = Instant::now() + Duration::from_secs(10);

        loop {
            if post_to(address, "/apps/missing/_actors/Counter/a/increment").is_ok() {
                return server;
            }
            if let Some(status) = server.child.try_wait().expect("read katsudou status") {
                panic!("katsudou exited during startup with {status}");
            }
            assert!(Instant::now() < deadline, "katsudou startup timed out");
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn post(&self, path: &str) -> HttpResponse {
        post_to(self.address, path).expect("send request to katsudou")
    }

    fn post_body(&self, path: &str, body: &str) -> HttpResponse {
        post_body_to(self.address, path, body).expect("send request to katsudou")
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct HttpResponse {
    status: u16,
    body: String,
}

fn post_to(address: SocketAddr, path: &str) -> io::Result<HttpResponse> {
    post_body_to(address, path, "[]")
}

fn post_body_to(address: SocketAddr, path: &str, body: &str) -> io::Result<HttpResponse> {
    let mut stream = TcpStream::connect(address)?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len(),
    );
    stream.write_all(request.as_bytes())?;
    stream.shutdown(Shutdown::Write)?;

    let mut response = Vec::new();
    stream.read_to_end(&mut response)?;
    parse_response(&response)
}

fn parse_response(response: &[u8]) -> io::Result<HttpResponse> {
    let Some(header_end) = response.windows(4).position(|window| window == b"\r\n\r\n") else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "HTTP response has no header terminator",
        ));
    };
    let headers = std::str::from_utf8(&response[..header_end])
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "HTTP status is missing"))?
        .parse()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let body = String::from_utf8(response[header_end + 4..].to_vec())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    Ok(HttpResponse { status, body })
}

fn assert_post(server: &Server, path: &str, status: u16, body: &str) {
    let response = server.post(path);
    assert_eq!(response.status, status, "{path}");
    assert_eq!(response.body, body, "{path}");
}

#[test]
fn actor_instances_keep_isolated_state_when_requests_return_to_an_earlier_actor() {
    let server = Server::spawn();

    assert_post(&server, "/apps/demo/_actors/Counter/a/increment", 200, "1");
    assert_post(&server, "/apps/demo/_actors/Counter/a/increment", 200, "2");
    assert_post(&server, "/apps/demo/_actors/Counter/b/increment", 200, "1");
    assert_post(
        &server,
        "/apps/demo/_actors/Counter/b/moduleCalls",
        200,
        "1",
    );
    assert_post(&server, "/apps/demo/_actors/Counter/a/increment", 200, "3");
    assert_post(
        &server,
        "/apps/demo/_actors/Counter/a/moduleCalls",
        200,
        "3",
    );
}

#[test]
fn unknown_route_segments_return_named_404_json() {
    let server = Server::spawn();

    assert_post(
        &server,
        "/apps/missing/_actors/Counter/a/increment",
        404,
        r#"{"error":"unknown app","appId":"missing"}"#,
    );
    assert_post(
        &server,
        "/apps/demo/_actors/Missing/a/increment",
        404,
        r#"{"error":"unknown actor type","actorType":"Missing"}"#,
    );
    assert_post(
        &server,
        "/apps/demo/_actors/Counter/a/missing",
        404,
        r#"{"error":"unknown action","action":"missing"}"#,
    );
}

#[test]
fn non_array_body_returns_400_json() {
    let server = Server::spawn();
    let path = "/apps/demo/_actors/Counter/a/increment";
    let response = server.post_body(path, "{}");

    assert_eq!(response.status, 400, "{path}");
    assert_eq!(
        response.body, r#"{"error":"request body must be a JSON array"}"#,
        "{path}"
    );
}

#[test]
fn reset_client_does_not_stop_server() {
    let server = Server::spawn();
    let stream = TcpStream::connect(server.address).expect("connect reset client");
    let socket = Socket::from(stream);
    socket
        .set_linger(Some(Duration::ZERO))
        .expect("enable reset-on-close");
    let request = format!(
        "POST /apps/missing/_actors/Counter/a/increment HTTP/1.1\r\nHost: {}\r\nContent-Length: 2\r\n\r\n[]",
        server.address
    );
    (&socket)
        .write_all(request.as_bytes())
        .expect("send reset request");
    drop(socket);
    thread::sleep(Duration::from_millis(50));

    assert_post(&server, "/apps/demo/_actors/Counter/a/increment", 200, "1");
}
