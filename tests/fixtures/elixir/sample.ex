defmodule MyApp.Accounts.User do
  @moduledoc """
  A user.
  """
  use Ecto.Schema
  use GenServer, restart: :temporary
  import Ecto.Changeset
  import MyApp.Helpers, only: [fmt: 1]
  alias MyApp.Repo
  alias MyApp.Accounts.{Session, Token}
  alias MyApp.Long.Name, as: LN
  require Logger

  defstruct [:id, name: ""]

  @max 3

  @doc "Finds a user."
  @spec find(integer) :: t()
  def find(id) when is_integer(id) do
    token = System.get_env("API_TOKEN")
    Repo.get(__MODULE__, id) |> normalize()
    Logger.info("x")
    helper(id)
    LN.call(id)
  end

  def create(attrs \\ %{}), do: %__MODULE__{} |> changeset(attrs)

  defp helper(x), do: x

  defmacro debug(expr) do
    quote do: IO.inspect(unquote(expr))
  end

  defmodule Inner do
    def go, do: :ok
  end
end

defmodule MyApp.UserTest do
  use ExUnit.Case, async: true
  alias MyApp.Accounts.User

  describe "find/1" do
    test "finds a user" do
      assert User.find(1)
    end
  end

  test "creates" do
    assert User.create()
  end
end
