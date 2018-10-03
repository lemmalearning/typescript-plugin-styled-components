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


    // NOTE: THe code that transpiles TaggedTemplateExpressions into ES5 is here: https://github.com/Microsoft/TypeScript/blob/5f96fb13b218201ef14b8c1b4a0fa15b54211fac/src/compiler/transformers/es2015.ts#L3944
    // NOTE: We currently do not output a TaggedTemplateExpressions because it will output duplicate data for the cooked and raw segments
    function transformTemplate(t: ts.TemplateLiteral) : ts.TemplateLiteral {

        var strs : (string|null)[] = [];

        function traverseExtract(t: ts.Node) {
            if(t.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
                t.kind === ts.SyntaxKind.TemplateHead ||
                t.kind === ts.SyntaxKind.TemplateMiddle ||
                t.kind === ts.SyntaxKind.TemplateTail
            ) {
                strs.push(t.text);
            }
            else if(t.kind === ts.SyntaxKind.TemplateExpression) {
                traverseExtract(t.head);
                t.templateSpans.map(traverseExtract);
            }
            else if(t.kind === ts.SyntaxKind.TemplateSpan) {
                strs.push(null);
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

                var v = strs.shift();
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
                var val = strs.shift();
                if(val !== null) {
                    throw new Error('Failure!')
                }

                return ts.createTemplateSpan(
                    t.expression,
                    traverseRecreate(t.literal)
                );
            }

            throw new Error('UNKNOWN TEMPLATE NODE', t);
        }


        traverseExtract(t);

        // This can be any string that won't change the general css syntax, but also won't ever appear in user created css (used so that we can deterministically resplit the minified source without dealing with source maps)
        var MARKER = String.fromCharCode(230);

        var combined = strs.map((s) => {
            if(s === null) { return MARKER }
            return s;
        }).join('');

        var out = stylis('', combined);
        out = out.slice(1, out.length - 1); // Removing rule curly braces (currently only supporting a single rule mode)

        // Re-separate
        strs = out.split(MARKER);
        for(var i = 1; i <= strs.length; i += 2) {
            strs.splice(i, 0, null);
        }

        return traverseRecreate(t);
    }


    const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
        const visitor: ts.Visitor = (node) => {

            if(isTaggedTemplateExpression(node)
                && isStyledFunction(node.tag)) {

                var tmpl = transformTemplate(node.template);

                // NOTE: You can uncomment this to work in stock styled-components
                //return ts.createTaggedTemplate(node.tag, tmpl);

                // TODO: Eventually we will split it up into one string per class that must be created 
                return ts.createCall(node.tag, undefined, [ tmpl ]);
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
