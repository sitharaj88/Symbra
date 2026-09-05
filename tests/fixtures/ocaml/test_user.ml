open Sample

let test_find () =
  let u = find_user (Hashtbl.create 1) 1 in
  Alcotest.(check bool) "absent" true (u = None)

let suite =
  [ Alcotest.test_case "finds a user" `Quick test_find ]

let () = Alcotest.run "user" [ ("store", suite) ]
