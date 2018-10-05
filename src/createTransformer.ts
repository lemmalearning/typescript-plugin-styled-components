import * as ts from 'typescript';
import {
    isPropertyAccessExpression,
    isCallExpression,
    isIdentifier,
    isVariableDeclaration,
    isExportAssignment,
    isTaggedTemplateExpression,
} from './ts-is-kind';

import {Options} from './models/Options';

var stylis = require('stylis');
var autoprefixer = require('autoprefixer');


/** Detects that a node represents a styled function
 * Recognizes the following patterns:
 *
 * styled.tag
 * Component.extend
 * styled(Component)
 * styledFunction.attrs(attributes)
*/
function isStyledFunction(node: ts.Node): boolean {
    if (isPropertyAccessExpression(node)) {
        if (isStyledObject(node.expression)) {
            return true;
        }

        if (node.name.text === 'extend'
            && isValidComponent(node.expression)) {

            return true;
        }

        return false;
    }

    if (isCallExpression(node) && node.arguments.length === 1) {

        if (isStyledObject(node.expression)) {
            return true;
        }

        if (isStyledAttrs(node.expression)) {
            return true;
        }
    }

    return false;
}

function isKeyframesIdentifier(node: ts.Node) {
    return isIdentifier(node) && node.text === 'keyframes';
}

function isStyledObject(node: ts.Node) {
    return node && isIdentifier(node) && node.text === 'styled';
}

function isValidComponent(node: ts.Node) {
    return node && isIdentifier(node) && isValidComponentName(node.text);
}

function isValidTagName(name: string) {
    return name[0] === name[0].toLowerCase();
}

function isValidComponentName(name: string) {
    return name[0] === name[0].toUpperCase();
}

function isStyledAttrs(node: ts.Node) {
    return node && isPropertyAccessExpression(node)
        && node.name.text === 'attrs'
        && isStyledFunction((node as ts.PropertyAccessExpression).expression);
}

function defaultGetDisplayName(filename: string, bindingName: string | undefined): string | undefined {
    return bindingName;
}

export function createTransformer(options?: Partial<Options>): ts.TransformerFactory<ts.SourceFile>
export function createTransformer({ getDisplayName = defaultGetDisplayName }: Partial<Options> = {}) {
    /**
     * Infers display name of a styled component.
     * Recognizes the following patterns:
     *
     * (const|var|let) ComponentName = styled...
     * export default styled...
    */
    function getDisplayNameFromNode(node: ts.Node): string | undefined {
        if (isVariableDeclaration(node) && isIdentifier(node.name)) {
            return getDisplayName(node.getSourceFile().fileName, node.name.text);
        }

        if (isExportAssignment(node)) {
            return getDisplayName(node.getSourceFile().fileName, undefined);
        }

        return undefined;
    }


    var stylisInst = new stylis({
        keyframe: false,
        prefix: false
    });

    // NOTE: We only use stylis is because less does not work synchronously
    // Also because stylis can't be configured for browser versions, we will use autoprefixer for vendor prefixes
    // NOTE: A stylis context is equivalent to wrapping the entire string in 'context { ... }' and evaluating it using less style nesting rules
    function compileCssString(context: string, str: string, singleKeyframe: boolean) : string {

        // Wrap keyframes to prevent stylis for contextualizing everything
        if(singleKeyframe) {
            str = '@keyframes x{' + str + '}';
        }

        str = stylisInst(context, str);


        // Unwrap
        if(singleKeyframe) {
            if(str.indexOf('@keyframes x{') !== 0 || str[str.length - 1] !== '}') {
                console.log('GOT OUT', str);
                throw new Error('Unexpected keyframe compilation');
            }

            str = str.slice('@keyframes x{'.length, str.length - 1);
        }

        str = autoprefixer.process(str).css
        return str;
    }


    // NOTE: THe code that transpiles TaggedTemplateExpressions into ES5 is here: https://github.com/Microsoft/TypeScript/blob/5f96fb13b218201ef14b8c1b4a0fa15b54211fac/src/compiler/transformers/es2015.ts#L3944
    // NOTE: We currently do not output a TaggedTemplateExpressions because it will output duplicate data for the cooked and raw segments
    function transformTemplate(t: ts.TemplateLiteral, singleKeyframe?: boolean) : ts.TemplateLiteral {

        var parts : (string|ts.Node)[] = [];

        function traverseExtract(t: ts.Node) {
            if(t.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
                t.kind === ts.SyntaxKind.TemplateHead ||
                t.kind === ts.SyntaxKind.TemplateMiddle ||
                t.kind === ts.SyntaxKind.TemplateTail
            ) {
                parts.push(t.text);
            }
            else if(t.kind === ts.SyntaxKind.TemplateExpression) {
                traverseExtract(t.head);
                t.templateSpans.map(traverseExtract);
            }
            else if(t.kind === ts.SyntaxKind.TemplateSpan) {
                parts.push(t.expression);
                traverseExtract(t.literal);
            }
            else {
                throw new Error('UNKNOWN TEMPLATE NODE', t);
            }
        }

        function traverseRecreate(t: ts.Node) : ts.Node {
            if(t.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
                t.kind === ts.SyntaxKind.TemplateHead ||
                t.kind === ts.SyntaxKind.TemplateMiddle ||
                t.kind === ts.SyntaxKind.TemplateTail
            ) {

                var factory = {
                    [ts.SyntaxKind.NoSubstitutionTemplateLiteral]: ts.createNoSubstitutionTemplateLiteral,
                    [ts.SyntaxKind.TemplateHead]: ts.createTemplateHead,
                    [ts.SyntaxKind.TemplateMiddle]: ts.createTemplateMiddle,
                    [ts.SyntaxKind.TemplateTail]: ts.createTemplateTail
                };

                var v = parts.shift();
                if(typeof(v) !== 'string') {
                    throw new Error('Failed');
                }

                return factory[t.kind]( v );
            }
            else if(t.kind === ts.SyntaxKind.TemplateExpression) {

                return ts.createTemplateExpression(
                    traverseRecreate(t.head),
                    t.templateSpans.map(traverseRecreate)
                );
            }
            else if(t.kind === ts.SyntaxKind.TemplateSpan) {
                // Should remove a null position
                var val = parts.shift();
                if(val !== t.expression) {
                    throw new Error('Failure!')
                }

                return ts.createTemplateSpan(
                    t.expression,
                    traverseRecreate(t.literal)
                );
            }

            throw new Error('UNKNOWN TEMPLATE NODE', t);
        }


        // This will generate the 'parts' array
        traverseExtract(t);

        // TODO: For maintaining compatibility with styled-components, we should minify the string parts here and them call traverseRecreate to rebuild the template for returning


        // TODO: Schenarious under which all this stuff will fail:
        // - if auto-prefixing results in duplicate versions of a single dynamic expresson
        // - if the minifier reorders rules then the expressions will be out of order

        // We will use all characters after this one to mark special tokens to be used for tracking the minification process without the need for dealing with source maps
        // NOTE: This implies that the CSS shouldn't have any unicode characters above this code
        var START_CODE = 230;
        var NEXT_CODE = START_CODE;
        var CLASS_MARKER = String.fromCharCode(NEXT_CODE++);

        var combined = parts.map((s) => {
            if(typeof(s) !== 'string') { return String.fromCharCode(NEXT_CODE++) }
            return s;
        }).join('');


        var out = compileCssString(CLASS_MARKER, combined, singleKeyframe);
        
        var rules = [];
        
        if(singleKeyframe) {
            rules = [out];
        }
        else {
            // Splitting it up into an array of rules based on parenenthesis termination (as all rules end in a final parenthesis if minified)
            var idx = 0;
            var level = 0;

            for(var i = 0; i < out.length; i++) {
                if(out[i] === '{') {
                    level++;
                }
                else if(out[i] === '}') {
                    level--;
    
                    if(level === 0) {
                        rules.push(out.slice(idx, i + 1));
                        idx = i + 1;
                    }
                }
            }
    
            if(idx !== out.length) {
                throw new Error('Failed to parse css rules');
            }
        }


        // TODO: Right here, check if all rules are just plain rules and don't require special injections

        
        // For convenience, we will remove all of the ts.Nodes from 
        var exprParts = [];
        parts.map((s) => {
            if(typeof(s) !== 'string') { exprParts.push(s) }
        })

        function exprFromChar(c) {
            return exprParts[c.charCodeAt(0) - START_CODE - 1]
        }


        var classNameArg = ts.createIdentifier('cls');
        var exprArgs : ts.Identifier[] = [];
        var exprVals = [];
        var argsByCode = {};

        var ruleNodes : ts.Node[][] = rules.map((r) => {

            var addTerms = [];
            //var left = null;

            var accum = '';

            function add(right) {
                addTerms.push(right);
                //if(left) { left = ts.createAdd(left, right); }
                //else { left = right; }
            }

            function addAccum() {
                if(accum.length > 0) {
                    add(ts.createLiteral(accum))
                    accum = '';
                }
            }


            enum CssPosition {
                None = 0,
                ElementRule = 1, // Meaning that we are in a position to do 'font-size: ...', etc.
                ElementSelector = 2,
                MediaSelector = 3
            }

            var pos : CssPosition = CssPosition.None 


            for(var i = 0; i < r.length; i++) {
                var n = null;

                if(pos === CssPosition.None) {
                    if(r[i] === '@') {
                        pos = CssPosition.MediaSelector
                    }
                    else if(r[i] === '}' || r[i] === ' ') {
                        // Still escaping from some previous nested rule
                    }
                    else {
                        pos = CssPosition.ElementSelector
                    }
                }
                
                if(pos === CssPosition.MediaSelector) {
                    if(r[i] === '{') {
                        // We assume that media rules will not be nested 
                        pos = CssPosition.ElementSelector;
                    }
                }
                else if(pos === CssPosition.ElementSelector) {
                    if(r[i] === '{') {
                        pos = CssPosition.ElementRule;
                    }
                }
                else if(pos === CssPosition.ElementRule) {
                    if(r[i] === '}') {
                        // Just exited a rule, on the next run, we will determine the type of selector that we are in
                        pos = CssPosition.None;
                    }
                }


                if(r[i] === CLASS_MARKER) {
                    addAccum();
                    add(classNameArg);
                }
                else if(r[i].charCodeAt(0) >= START_CODE) {

                    var isClassRef = pos === CssPosition.ElementSelector;
                    var isAnimRef =  pos === CssPosition.ElementRule && (/animation(-name)?:\s*$/i).exec(accum.trim());

                    // NOTE: This assumes that we do not allow regular templating in the selector
                    if(isClassRef) {
                        accum += '.';
                    }

                    addAccum();

                    // If the expression was also exported as an argument, use that
                    if(argsByCode[r[i]]) {
                        add(argsByCode[r[i]]);
                    }
                    // May need to add it as a new argument
                    else if(isClassRef || isAnimRef) {
                        let arg = ts.createIdentifier('expr' + exprArgs.length);
                        exprArgs.push(arg);
                        exprVals.push(exprFromChar(r[i]));
                        argsByCode[r[i]] = arg;

                        add(arg);
                    }
                    // Otherwise add the expression inline into the expression
                    else {
                        add(exprFromChar(r[i]));
                    }
                }
                else {
                    accum += r[i];
                }
            }

            addAccum();

            return addTerms;
        });

        // TODO: When would this happen?
        ruleNodes = ruleNodes.filter((arr) => arr.length > 0);


        function addUpRules() {
            ruleNodes = ruleNodes.map((arr) => {
                var left = arr[0];
                for(var i = 1; i < arr.length; i++) {
                    left = ts.createAdd(left, arr[i]);
                }

                return left;
            })
        }

        if(singleKeyframe) {
            if(exprVals.length > 0) {
                throw new Error('Did not expect component references in keyframes');
            }
            if(ruleNodes.length !== 1) {
                throw new Error('Unexpected keyframes count');
            }


            addUpRules();


            return { tmpl: ruleNodes[0], args: [] };
        } 


        if(exprVals.length === 0) {
            var allSimple = true;
            var simpleStrings = [];
            var isSuperSimple = true;
            // If all rules never needed to mix in the className, then we reduce to simple strings output
            for(var i = 0; i < rules.length; i++) {
                var r = rules[i];
                if(r[0] === CLASS_MARKER && r.lastIndexOf(CLASS_MARKER) === 0) {
                    if(r[1] !== '{') {
                        isSuperSimple = false;
                    }

                    simpleStrings.push(r.slice(2, r.length - 1))
                }
                else {
                    allSimple = false;
                    break;
                }
            }

            if(allSimple) {
                var collapseSingle =  ruleNodes.length === 1 && isSuperSimple;

               ruleNodes.map((rn) => {
                    if(rn[0] !== classNameArg) {
                        throw new Error('Unexpected!');
                    }

                    rn.splice(0, 1); // Removing the class name variable for the addition

                    if(collapseSingle) {
                        if(rn[0].text[0] !== '{') {
                            throw new Error('Unexpected 1!');
                        }

                        rn[0].text = rn[0].text.slice(1); // Removing the '{'
                    }

                    if(collapseSingle) {
                        var last = rn[rn.length - 1];
                        if(last.text[last.text.length - 1] !== '}') {
                            throw new Error('Unexpected 2!');
                        }

                        last.text = last.text.slice(0, last.text.length - 1); // Removing the '}'

                        if(last.text.length === 0) {
                            rn.splice(rn.length - 1, 1);
                        }
                    }
                })
                
                addUpRules();

                if(collapseSingle) {
                    ruleNodes = ruleNodes[0];
                }
                else {
                    ruleNodes = ts.createArrayLiteral(ruleNodes);
                }

                return { tmpl: ruleNodes, args: [] };
            }
        }


        addUpRules();


        var body = ts.createArrayLiteral(ruleNodes);

        var fn = ts.createArrowFunction(undefined, undefined, [
                ts.createParameter(undefined, undefined, undefined, 'cls')
            
            ].concat(exprArgs.map((arg) => {
                return ts.createParameter(undefined, undefined, undefined, arg.text)
            })),
            undefined, undefined,
            body
        );

        return { tmpl: fn, args: exprVals };



        /*
        // XXX: Additionally all segments of it must be in the form of simple rules
        // In this case, we have a very simple single class rule
        if(out[0] === CLASS_MARKER && out.lastIndexOf(CLASS_MARKER) === 0 && out[1] === '{') {
            out = out.slice(2, out.length - 1); // Removing rule curly braces and class marker

            // Re-separate
            var newStrs = out.split(MARKER);
            for(var i = 1; i <= newStrs.length; i += 2) {
                newStrs.splice(i, 0, strs[i]);
            }

            strs = newStrs;
    
            return traverseRecreate(t);
        }
        // Otherwise we have more than one rule, so we will create a function which evaluates to an array of rules given the class name
        else {



            var v = ts.createIdentifier('c');

            var exprs = [];
            strs.map((s) => {
                if(typeof(s) !== 'string') { exprs.push(s) }
            })

            var ruleNodes = rules.map((r) => {

                var left = null;

                var accum = '';

                function addAccum() {
                    if(accum.length > 0) {
                        if(left) {
                            left = ts.createAdd(left, ts.createLiteral(accum));
                        }
                        else {
                            left = ts.createLiteral(accum)
                        }

                        accum = '';
                    }
                }

                for(var i = 0; i < r.length; i++) {
                    var n = null;
                    if(r[i] === CLASS_MARKER) {
                        n = v;
                    }
                    else if(r[i] === MARKER) {
                        n = exprs.shift();
                    }

                    if(n) {
                        addAccum();

                        if(left) {
                            left = ts.createAdd(left, n);
                        }
                        else {
                            left = n;
                        }
                    }
                    else {
                        accum += r[i];
                    }
                }

                addAccum();

                return left;

            }).filter((r) => r !== null);

            
        }
        */

        
    }

    // Simple, opinionated, no thrills styling with React + Typescript

    const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
        const visitor: ts.Visitor = (node) => {

            if(isTaggedTemplateExpression(node)
                && (isStyledFunction(node.tag) || isKeyframesIdentifier(node.tag))) {

                var tmpl;
                var extraArgs = [];

                // Keyframe rules should always be super simple and not require splitting into multiple rules
                // TODO: This still needs to be minified, just doesn't need to 
                if(isKeyframesIdentifier(node.tag)) {
                    tmpl = transformTemplate(node.template, true).tmpl;
                }
                else {
                    var tf = transformTemplate(node.template)
                    tmpl = tf.tmpl;
                    extraArgs = tf.args;
                }

                // NOTE: You can uncomment this to work in stock styled-components
                //return ts.createTaggedTemplate(node.tag, tmpl);

                // TODO: Eventually we will split it up into one string per class that must be created 
                return ts.createCall(node.tag, undefined, [ tmpl ].concat(extraArgs));
            }

            /*
            if (node.parent
                && isTaggedTemplateExpression(node.parent)
                && node.parent.tag === node
                && node.parent.parent
                && isVariableDeclaration(node.parent.parent)
                && isStyledFunction(node)) {

                const displayName = getDisplayNameFromNode(node.parent.parent);

                if (displayName) {
                    return ts.createCall(
                        ts.createPropertyAccess(node as ts.Expression, 'withConfig'),
                        undefined,
                        [ts.createObjectLiteral([ts.createPropertyAssignment('displayName', ts.createLiteral(displayName))])]);
                }
            }

            ts.forEachChild(node, n => {
                if (!n.parent)
                    n.parent = node;
            });
            */

            return ts.visitEachChild(node, visitor, context);
        }

        return (node) => ts.visitNode(node, visitor);
    };

    return transformer;
}

export default createTransformer;
