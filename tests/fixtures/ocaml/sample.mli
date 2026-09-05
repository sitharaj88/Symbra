(** Interface for the sample module. *)

type user = {
  id : int;
  name : string;
}

type status = Active | Suspended of string | Closed

type user_table

(** Find a user by id. *)
val find_user : user_table -> int -> user option

val render_user : user -> string

val max_retries : int

module type STORE = sig
  val get : int -> user option
end
