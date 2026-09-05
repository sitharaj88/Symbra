import Foundation
import XCTest

/// A base protocol.
public protocol Repo: Sendable {
    func find(id: Int) -> User?
    var count: Int { get }
}

/// A user model.
public struct User: Codable, Equatable {
    let id: Int
    var name: String
    static let empty = User(id: 0, name: "")
}

enum Status: String {
    case active, inactive
    case pending = "p"
}

open class BaseRepo {
    fileprivate var cache: [Int: User] = [:]
    public init() {}
    func load() {}
}

/// User repository.
final class UserRepo: BaseRepo, Repo {
    private let session: Session
    var count: Int { return cache.count }
    override init() { self.session = Session(); super.init() }
    public func find(id: Int) -> User? {
        let u = User(id: id, name: "x")
        let token = ProcessInfo.processInfo.environment["API_TOKEN"]
        session.get(url: "x", retries: 2)
        return self.cache[id] ?? helper(u)
    }
    private static func helper(_ u: User) async throws -> User { return u }
    @objc func fooObjc() {}
}

extension UserRepo {
    func extra() -> Int { return load2() }
}

typealias UserMap = [Int: User]
let GLOBAL_CONST = 3
var mutableGlobal = "a"

actor Counter {
    var value = 0
    func inc() { value += 1 }
}

func topLevel(a: Int, b: UserRepo) -> String { return "\(a)" }

class UserRepoTests: XCTestCase {
    func testFind() { let r = UserRepo(); XCTAssertNotNil(r.find(id: 1)) }
}
