#pragma once
#include <string>
#include <memory>
#include "base/entity.hpp"

namespace acme {
namespace db {

/// Base repository.
class Repo : public Entity, private Serializable {
public:
    explicit Repo(const std::string& name);
    virtual ~Repo();
    virtual User find(int id) const = 0;
    void save(const User& u);
    static int count();
    friend class Inspector;
protected:
    std::string name_;
    std::unique_ptr<Cache> cache_;
private:
    int hidden_ = 0;
};

struct Point { int x; int y; };

enum class Color { Red, Green, Blue };
enum Legacy { OLD, NEW };

template <typename T>
class Box {
public:
    T value;
    T get() const { return value; }
};

template <typename T>
T clamp(T v, T lo, T hi);

using UserPtr = std::shared_ptr<User>;
typedef int Id;

} // namespace db
} // namespace acme
