import { read_str } from './reader.js'
import { _pr_str } from './printer.js'
import { Env } from './env.js'
import * as types from './types.js'
import * as core from './core.js'
import core_clj from './clj/core.clj?raw'

// read
function READ(str) {
    return read_str(str);
}

// eval 
function qqLoop(acc, elt) {
    if (types._list_Q(elt) && elt.length
        && types._symbol_Q(elt[0]) && elt[0].value == 'splice-unquote') {
        return [types._symbol("concat"), elt[1], acc];
    } else {
        return [types._symbol("cons"), quasiquote(elt), acc];
    }
}
function quasiquote(ast) {
    if (types._list_Q(ast) && 0 < ast.length
        && types._symbol_Q(ast[0]) && ast[0].value == 'unquote') {
        return ast[1];
    } else if (types._list_Q(ast)) {
        return ast.reduceRight(qqLoop, []);
    } else if (types._vector_Q(ast)) {
        return [types._symbol("vec"), ast.reduceRight(qqLoop, [])];
    } else if (types._symbol_Q(ast) || types._hash_map_Q(ast)) {
        return [types._symbol("quote"), ast];
    } else {
        return ast;
    }
}

function is_macro_call(ast, env) {
    return types._list_Q(ast) &&
        types._symbol_Q(ast[0]) &&
        env.find(ast[0]) &&
        env.get(ast[0])._ismacro_;
}

function macroexpand(ast, env) {
    while (is_macro_call(ast, env)) {
        var mac = env.get(ast[0]);
        ast = mac.apply(mac, ast.slice(1));
    }
    return ast;
}

function eval_ast(ast, env) {
    //console.log("eval_ast:", ast, env)
    if (types._symbol_Q(ast)) {
        return env.get(ast);
    } else if (types._list_Q(ast)) {
        return ast.map(function (a) { return EVAL(a, env); });
    } else if (types._vector_Q(ast)) {
        var v = ast.map(function (a) { return EVAL(a, env); });
        v.__isvector__ = true;
        return v;
    } else if (types._hash_map_Q(ast)) {
        var new_hm = new Map();
        for (var [key, value] of ast) {
            new_hm.set(key, EVAL(ast.get(key), env))
        }
        return new_hm;
    } else {
        return ast;
    }
}

export function clearTests() {
    deftests = []
}

export var deftests = []
var arglist
var fnBody
var isMultiArity

// We need to store the loop ast, bindings and env
// so we can pass it to recur when we get to it.
// The current strategy fails in the case that one loop
// calls into another in its body.
// My next idea is to, instead of replacing it,
// we append it to a stack or something.
var loopBodies = []
var loopBindings = []
var loopEnvs = []

function walk(inner, outer, form) {
    //console.log("Walking form:", form)
    if (types._list_Q(form)) {
        return outer(form.map(inner))
    } else if (form === null) {
        return null
    }
    else if (types._vector_Q(form)) {
        let v = outer(form.map(inner))
        v.__isvector__ = true;
        return v
    } else if (form.__mapEntry__) {
        const k = inner(form[0])
        const v = inner(form[1])
        let mapEntry = [k, v]
        mapEntry.__mapEntry__ = true
        return outer(mapEntry)
    } else if (types._hash_map_Q(form)) {
        let newMap = new Map()
        form.forEach((value, key, map) => newMap.set(key, inner(value)))
        return outer(newMap)
    } else {
        return outer(form)
    }
}

export function postwalk(f, form) {
    return walk(x => postwalk(f, x), f, form)
}

function hasLet(ast) {
    let lets = []
    postwalk(x => {
        if (x.value == types._symbol("let*")) {
            lets.push(true)
            return true
        } else {
            return x
        }
        return x
    }, ast)
    if (lets.length > 0) {
        return true
    } else {
        return false
    }
}

function _EVAL(ast, env) {
    while (true) {
        //console.log(ast)
        //console.log(env)
        if (!types._list_Q(ast)) {
            return eval_ast(ast, env);
        }

        // apply list
        ast = macroexpand(ast, env);
        if (!types._list_Q(ast)) {
            return eval_ast(ast, env);
        }
        if (ast.length === 0) {
            return ast;
        }

        var a0 = ast[0], a1 = ast[1], a2 = ast[2], a3 = ast[3];
        // Keyword functions:
        // If the first element is a keyword,
        // it looks up its value in its argument
        if (types._keyword_Q(a0)) {
            return EVAL([types._symbol("get"), a1, a0], env)
        }
        // hash-maps as functions of keys
        if (types._hash_map_Q(a0)) {
            return EVAL([types._symbol("get"), a0, a1], env)
        }
        // vectors as functions of indices
        if (types._vector_Q(a0)) {
            return EVAL([types._symbol("get"), a0, a1], env)
        }
        switch (a0.value) {
            case "ns":
            case "discard":
                return null
            case "dispatch":
                //console.log("eval dispatch")
                // Regex
                if (types._string_Q(a1)) {
                    const re = new RegExp(a1, 'g')
                    return re
                }
                // Anonymous function shorthand
                if (types._list_Q(a1)) {
                    let fun = [types._symbol('fn')]
                    var args = Array.from(new Set(ast.toString().match(/%\d?/g))).map(types._symbol)
                    let body = ast.slice(1)[0]
                    fun.push(args)
                    fun.push(body)
                    var lambda = types._function(EVAL, Env, body, env, args, a0);
                    lambda.lambda = true
                    return lambda
                }
            case "def":
                var res = EVAL(a2, env);
                env.set(a1, res);
                return res
            case "let*":
                var let_env = new Env(env);
                for (var i = 0; i < a1.length; i += 2) {
                    let_env.set(a1[i], EVAL(a1[i + 1], let_env));
                }
                ast = a2;
                env = let_env;
                break;
            case "loop":
                var loopEnv = new Env(env)
                var loopBody = [types._symbol('do')].concat(ast.slice(2))
                for (var i = 0; i < a1.length; i += 2) {
                    loopEnv.set(a1[i], EVAL(a1[i + 1], loopEnv))
                }
                loopBindings.push(a1)
                loopEnvs.push(loopEnv)
                loopBodies.push(loopBody)
                // Tag the recur form with metadata so the correct
                // loop body, bindings & env can be identified
                const loop_body = postwalk(x => {
                    if (types._symbol_Q(x[0]) && x[0].value === 'recur') {
                        x.__number__ = loopBodies.length-1
                     }
                     return x
                 }, loopBody)
                ast = loop_body
                env = loopEnv
                break
            case "recur":
                console.log("loop AST num:", ast.__number__, PRINT(ast), ast)
                console.log("raw recurForms:", PRINT(ast.slice(1)))
                const recurForms = eval_ast(ast.slice(1), loopEnvs[ast.__number__])
                console.log("evaled recurForms:", PRINT(recurForms))
                console.log("setting bindings", PRINT(loopBindings[ast.__number__]))
                var locals = []
                for (let i = 0; i < loopBindings[ast.__number__].length; i+=2) {
                    locals.push(loopBindings[ast.__number__][i])
                }
                for (var i = 0; i < locals.length; i++) {
                    loopEnvs[ast.__number__].set(locals[i], recurForms[i]);
                    console.log("re-binding", locals[i].value, "to", PRINT(recurForms[i]))
                }
                ast = loopBodies[ast.__number__]
                console.log("exiting recur. AST:", PRINT(ast))
                break
            case 'deftest':
                var res = ast.slice(2).map((x) => EVAL(x, env))
                env.set(a1, res);
                deftests.push({ test: a1, result: res })
                return res
            case 'testing':
                return EVAL(a2, env)
            case "quote":
                return a1;
            case "quasiquoteexpand":
                return quasiquote(a1);
            case "quasiquote":
                ast = quasiquote(a1);
                break;
            case 'defmacro':
                var body = [types._symbol("do")].concat(ast.slice(3))
                var func = types._function(EVAL, Env, body, env, a2, a1)
                func._ismacro_ = true;
                return env.set(a1, func);
            case 'macroexpand':
                return macroexpand(a1, env);
            case "try":
                try {
                    return EVAL(a1, env);
                } catch (exc) {
                    if (a2 && a2[0].value === "catch") {
                        if (exc instanceof Error) { exc = exc.message; }
                        return EVAL(a2[2], new Env(env, [a2[1]], [exc]));
                    } else {
                        throw exc;
                    }
                }
            case "do":
                eval_ast(ast.slice(1, -1), env);
                ast = ast[ast.length - 1];
                break;
            case "if":
                var cond = EVAL(a1, env);
                if (cond === null || cond === false) {
                    ast = (typeof a3 !== "undefined") ? a3 : null;
                } else {
                    ast = a2;
                }
                break;
            case "fn":
                //console.log("defining fn", ast)
                var lambda = types._function(EVAL, Env, a2, env, a1, a0);
                lambda.lambda = true
                return lambda
            default:
                //console.log("calling", ast)
                for (let i = 0; i < ast.slice(1).length; i++) {
                    //console.log(ast.slice(1)[i])
                }
                var el = eval_ast(ast, env), f = el[0];
                if (f.lambda) {
                    //console.log("fn is a lambda", f.__ast__)
                }
                if (f.__ast__) {
                    //console.log("lambda AST:", f.__ast__)
                    ast = f.__ast__;
                    env = f.__gen_env__(el.slice(1));
                    //console.log("lambda env:", env)
                } else {
                    var res = f.apply(f, el.slice(1));
                    return res
                }
        }
    }
}

function EVAL(ast, env) {
    var result = _EVAL(ast, env);
    return (typeof result !== "undefined") ? result : null;
}

// print
function PRINT(exp) {
    //console.log("PRINT:", exp)
    return _pr_str(exp, true);
}

export var repl_env = new Env();

export const evalString = function (str) {
    return PRINT(EVAL(READ(str), repl_env))
};

// core.js: defined using javascript
for (var n in core.ns) { repl_env.set(types._symbol(n), core.ns[n]); }
repl_env.set(types._symbol('eval'), function (ast) {
    return EVAL(ast, repl_env);
});
repl_env.set(types._symbol('*ARGV*'), []);

// load core.clj
evalString("(do " + core_clj + ")")