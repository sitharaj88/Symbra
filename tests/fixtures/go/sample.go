// Package sample is a fixture for the Go extractor.
package sample

import (
	"fmt"
	"net/http"
	"os"

	gin "github.com/gin-gonic/gin"
	"github.com/example/app/internal/store"
)

// MaxRetries is the retry budget.
const MaxRetries = 3

const (
	// Version string.
	Version = "1.0"
	debug   = false
)

// DefaultStore is the shared store.
var DefaultStore = store.NewStore()

var counter int

var typed *Cache = &Cache{}

// Cache holds entries.
type Cache struct {
	entries map[string]string
}

// User is a domain entity.
type User struct {
	// ID identifies the user.
	ID    int
	Name  string `json:"name"`
	cache *Cache
	Base
	*store.Meta
}

// Repo finds things.
type Repo interface {
	// Find returns a user.
	Find(id int) (*User, error)
	Close() error
}

// Alias for ids.
type ID = int

type Handler func(w http.ResponseWriter, r *http.Request)

// NewUser builds a User.
func NewUser(name string) *User {
	u := &User{Name: name}
	u.cache = &Cache{}
	return u
}

// Greet says hello.
func (u *User) Greet(prefix string) string {
	fmt.Println(prefix)
	u.Save()
	return prefix + u.Name
}

func (u User) Save() error {
	return nil
}

// Find looks up a user.
func (c *Cache) Find(id int) (*User, error) {
	var repo Repo = store.Open()
	user := NewUser("x")
	other := User{Name: "y"}
	svc := store.NewService()
	svc.Run()
	repo.Close()
	other.Greet("hi")
	return user, nil
}

// Map is generic.
func Map[T any, U any](xs []T, f func(T) U) []U {
	out := make([]U, 0, len(xs))
	for _, x := range xs {
		out = append(out, f(x))
	}
	return out
}

func helper() {
	token := os.Getenv("API_TOKEN")
	if v, ok := os.LookupEnv("DEBUG"); ok {
		fmt.Println(v, token)
	}
}

func registerRoutes() {
	http.HandleFunc("/health", healthHandler)
	mux := http.NewServeMux()
	mux.HandleFunc("/users", listUsers)
	r := gin.Default()
	r.GET("/users/:id", getUser)
	r.POST("/users", createUser)
	e := echo.New()
	e.DELETE("/users/:id", deleteUser)
	router := chi.NewRouter()
	router.Get("/ping", pingHandler)
}

func healthHandler(w http.ResponseWriter, r *http.Request) {}
func listUsers(w http.ResponseWriter, r *http.Request)     {}
func getUser(c *gin.Context)                               {}
func createUser(c *gin.Context)                            {}
func deleteUser(c *gin.Context)                            {}
func pingHandler(w http.ResponseWriter, r *http.Request)   {}

func TestGreet(t *testing.T) {
	u := NewUser("a")
	u.Greet("b")
	r := gin.Default()
	r.GET("/ignored", getUser)
}

func BenchmarkGreet(b *testing.B) {
	NewUser("a")
}

func main() {
	helper()
	registerRoutes()
}
