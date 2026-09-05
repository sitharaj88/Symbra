#ifndef SAMPLE_H
#define SAMPLE_H
#include <stdio.h>
#include "util/helpers.h"

#define MAX_ITEMS 10
#define SQUARE(x) ((x) * (x))

/** A point. */
struct point { int x; int y; };
typedef struct point point_t;
typedef int (*callback_fn)(int);

union value { int i; float f; };

enum color { RED, GREEN = 2, BLUE };

/* Adds two numbers. */
int add(int a, int b);
struct point *make_point(int x, int y);
extern int counter;
static const int LIMIT = 5;
#endif
