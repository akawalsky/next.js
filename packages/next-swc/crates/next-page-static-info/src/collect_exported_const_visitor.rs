use std::collections::{HashMap, HashSet};

use serde_json::{Map, Number, Value};
use swc_core::{
    common::{Mark, SyntaxContext},
    ecma::{
        ast::{
            BindingIdent, Decl, ExportDecl, Expr, Lit, Pat, Prop, PropName, PropOrSpread, VarDecl,
            VarDeclKind, VarDeclarator,
        },
        utils::{ExprCtx, ExprExt},
        visit::{Visit, VisitWith},
    },
};

/// The values extracted for the corresponding AST node.
/// refer extract_expored_const_values for the supported value types.
/// Undefined / null is treated as None.
pub enum Const {
    Value(Value),
    Unsupported,
}

pub(crate) struct CollectExportedConstVisitor {
    pub properties: HashMap<String, Option<Const>>,
    expr_ctx: ExprCtx,
}

impl CollectExportedConstVisitor {
    pub fn new(properties_to_extract: HashSet<String>) -> Self {
        Self {
            properties: properties_to_extract
                .into_iter()
                .map(|p| (p, None))
                .collect(),
            expr_ctx: ExprCtx {
                unresolved_ctxt: SyntaxContext::empty().apply_mark(Mark::new()),
                is_unresolved_ref_safe: false,
            },
        }
    }
}

impl Visit for CollectExportedConstVisitor {
    fn visit_export_decl(&mut self, export_decl: &ExportDecl) {
        match &export_decl.decl {
            Decl::Var(box VarDecl { kind, decls, .. }) if kind == &VarDeclKind::Const => {
                for decl in decls {
                    if let VarDeclarator {
                        name: Pat::Ident(BindingIdent { id, .. }),
                        init: Some(init),
                        ..
                    } = decl
                    {
                        let id = id.sym.as_ref();
                        if let Some(prop) = self.properties.get_mut(id) {
                            *prop = extract_value(&self.expr_ctx, init);
                        };
                    }
                }
            }
            _ => {}
        }

        export_decl.visit_children_with(self);
    }
}

/// Coerece the actual value of the given ast node.
fn extract_value(ctx: &ExprCtx, init: &Expr) -> Option<Const> {
    match init {
        init if init.is_undefined(ctx) => Some(Const::Value(Value::Null)),
        Expr::Ident(_) => Some(Const::Unsupported),
        Expr::Lit(lit) => match lit {
            Lit::Num(num) => Some(Const::Value(Value::Number(
                Number::from_f64(num.value).expect("Should able to convert f64 to Number"),
            ))),
            Lit::Null(_) => Some(Const::Value(Value::Null)),
            Lit::Str(s) => Some(Const::Value(Value::String(s.value.to_string()))),
            Lit::Bool(b) => Some(Const::Value(Value::Bool(b.value))),
            Lit::Regex(r) => Some(Const::Value(Value::String(format!(
                "/{}/{}",
                r.exp, r.flags
            )))),
            _ => Some(Const::Unsupported),
        },
        Expr::Array(arr) => {
            let mut a = vec![];

            for elem in &arr.elems {
                match elem {
                    Some(elem) => {
                        if elem.spread.is_some() {
                            return Some(Const::Unsupported);
                        }

                        match extract_value(ctx, &elem.expr) {
                            Some(Const::Value(value)) => a.push(value),
                            _ => return Some(Const::Unsupported),
                        }
                    }
                    None => {
                        a.push(Value::Null);
                    }
                }
            }

            Some(Const::Value(Value::Array(a)))
        }
        Expr::Object(obj) => {
            let mut o = Map::new();

            for prop in &obj.props {
                let kv = match prop {
                    PropOrSpread::Prop(box Prop::KeyValue(kv)) => match kv.key {
                        PropName::Ident(_) | PropName::Str(_) => kv,
                        _ => return Some(Const::Unsupported),
                    },
                    _ => return Some(Const::Unsupported),
                };

                let key = match &kv.key {
                    PropName::Ident(i) => i.sym.as_ref(),
                    PropName::Str(s) => s.value.as_ref(),
                    _ => return Some(Const::Unsupported),
                };
                let new_value = extract_value(ctx, &kv.value);
                if let Some(Const::Unsupported) = new_value {
                    return Some(Const::Unsupported);
                }

                if let Some(Const::Value(value)) = new_value {
                    o.insert(key.to_string(), value);
                }
            }

            Some(Const::Value(Value::Object(o)))
        }
        Expr::Tpl(tpl) => {
            // [TODO] should we add support for `${'e'}d${'g'}'e'`?
            if !tpl.exprs.is_empty() {
                Some(Const::Unsupported)
            } else {
                Some(
                    tpl.quasis
                        .first()
                        .map(|q| {
                            // When TemplateLiteral has 0 expressions, the length of quasis is
                            // always 1. Because when parsing
                            // TemplateLiteral, the parser yields the first quasi,
                            // then the first expression, then the next quasi, then the next
                            // expression, etc., until the last quasi.
                            // Thus if there is no expression, the parser ends at the frst and also
                            // last quasis
                            //
                            // A "cooked" interpretation where backslashes have special meaning,
                            // while a "raw" interpretation where
                            // backslashes do not have special meaning https://exploringjs.com/impatient-js/ch_template-literals.html#template-strings-cooked-vs-raw
                            let cooked = q.cooked.as_ref();
                            let raw = q.raw.as_ref();

                            Const::Value(Value::String(
                                cooked.map(|c| c.to_string()).unwrap_or(raw.to_string()),
                            ))
                        })
                        .unwrap_or(Const::Unsupported),
                )
            }
        }
        _ => Some(Const::Unsupported),
    }
}
