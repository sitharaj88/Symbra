namespace App.Service

open System
open App.Store.Repo

/// A user record.
type User =
    { Id: int
      Name: string }

/// Account status.
type Status =
    | Active
    | Suspended of reason: string
    | Closed

/// Things that can be stored.
type IStore =
    abstract member Get: int -> User option
    abstract member Put: User -> unit

/// In-memory store.
type MemoryStore(capacity: int) =
    inherit BaseStore()
    let mutable count = 0

    /// Current item count.
    member this.Count = count

    member this.Add(u: User) =
        count <- count + 1
        u

    interface IStore with
        member this.Get id = None
        member this.Put u = ()

module Users =
    /// Find a user by id.
    let findUser (table: Map<int, User>) uid = Map.tryFind uid table

    let rec normalize (s: string) = s.ToLower()

    let renderUser (u: User) = normalize u.Name

    let maxRetries = 3

    let apiToken = Environment.GetEnvironmentVariable "API_TOKEN"

    [<Test>]
    let ``normalize is idempotent`` () =
        normalize "AB" = normalize (normalize "AB")

    [<Fact>]
    let testRender () =
        let store = MemoryStore(4)
        store.Add({ Id = 1; Name = "a" }) |> ignore
