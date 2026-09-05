(** Sample module for extractor tests. *)

open Core
open Store.Repo
include Utils

(** A user record. *)
type user = {
  id : int;
  name : string;
}

(** Account status. *)
type status =
  | Active
  | Suspended of string
  | Closed

type user_table = (int, user) Hashtbl.t

module type STORE = sig
  val get : int -> user option
  val put : user -> unit
end

module Store = struct
  (** In-memory table. *)
  let table : user_table = Hashtbl.create 16

  let get id = Hashtbl.find_opt table id

  let put u = Hashtbl.replace table u.id u
end

class counter init = object
  val mutable n = init
  method bump () = n <- n + 1
  method value = n
end

(** Find a user by id. *)
let find_user table uid =
  Hashtbl.find_opt table uid

let rec render_user u = normalize u.name
and normalize s = String.lowercase_ascii s

let max_retries = 3

let api_token = Sys.getenv "API_TOKEN"

let%test "normalize is idempotent" = normalize "AB" = normalize (normalize "AB")
