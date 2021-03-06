import * as ts from 'typescript';
import { CodeTemplate, CodeTemplateFactory, CTemplateBase } from '../../template';
import { StandardCallResolver, IResolver } from '../../standard';
import { ArrayType, NumberVarType } from '../../types/ctypes';
import { IScope } from '../../program';
import { CVariable } from '../../nodes/variable';
import { CExpression } from '../../nodes/expressions';
import { CElementAccess, CSimpleElementAccess } from '../../nodes/elementaccess';
import { TypeHelper } from '../../types/typehelper';

@StandardCallResolver
class ArraySliceResolver implements IResolver {
    public matchesNode(typeHelper: TypeHelper, call: ts.CallExpression) {
        if (call.expression.kind != ts.SyntaxKind.PropertyAccessExpression)
            return false;
        let propAccess = <ts.PropertyAccessExpression>call.expression;
        let objType = typeHelper.getCType(propAccess.expression);
        return propAccess.name.getText() == "slice" && objType instanceof ArrayType;
    }
    public returnType(typeHelper: TypeHelper, call: ts.CallExpression) {
        let { size, dynamic, elementType } = getSliceParams(typeHelper, call);
        return new ArrayType(elementType, size, dynamic);
    }
    public createTemplate(scope: IScope, node: ts.CallExpression) {
        return new CArraySlice(scope, node);
    }
    public needsDisposal(typeHelper: TypeHelper, call: ts.CallExpression) {
        let { dynamic } = getSliceParams(typeHelper, call);
        return call.parent.kind != ts.SyntaxKind.ExpressionStatement && dynamic;
    }
    public getTempVarName(typeHelper: TypeHelper, node: ts.CallExpression) {
        return "tmp_slice";
    }
    public getEscapeNode(typeHelper: TypeHelper, node: ts.CallExpression) {
        return null;
    }
}

@CodeTemplate(`
{#statements}
    {#if !topExpressionOfStatement && simpleSlice }
        for ({iteratorVarName} = 0; {iteratorVarName} < {simpleSliceSize}; {iteratorVarName}++)
            {tempVarName}[{iteratorVarName}] = {arrayDataAccess}[{iteratorVarName} + {simpleSliceStart}];
    {#elseif !topExpressionOfStatement && !simpleSlice && !endIndexArg}
        {sizeVarName} = ({startIndexArg}) < 0 ? -({startIndexArg}) : {arraySize} - ({startIndexArg});
        {startVarName} = ({startIndexArg}) < 0 ? {arraySize} + ({startIndexArg}) : ({startIndexArg});
        ARRAY_CREATE({tempVarName}, {sizeVarName}, {sizeVarName});
        for ({iteratorVarName} = 0; {iteratorVarName} < {sizeVarName}; {iteratorVarName}++)
            {tempVarName}->data[{iteratorVarName}] = {arrayDataAccess}[{iteratorVarName} + {startVarName}];
    {#elseif !topExpressionOfStatement && !simpleSlice && endIndexArg}
        {startVarName} = ({startIndexArg}) < 0 ? {arraySize} + ({startIndexArg}) : ({startIndexArg});
        {endVarName} = ({endIndexArg}) < 0 ? {arraySize} + ({endIndexArg}) : ({endIndexArg});
        {sizeVarName} = {endVarName} - {startVarName};
        ARRAY_CREATE({tempVarName}, {sizeVarName}, {sizeVarName});
        for ({iteratorVarName} = 0; {iteratorVarName} < {sizeVarName}; {iteratorVarName}++)
            {tempVarName}->data[{iteratorVarName}] = {arrayDataAccess}[{iteratorVarName} + {startVarName}];
    {/if}
{/statements}
{#if topExpressionOfStatement}
    /* slice doesn't have side effects, skipping */
{#else}
    {tempVarName}
{/if}`)
class CArraySlice extends CTemplateBase {
    public topExpressionOfStatement: boolean;
    public tempVarName: string = '';
    public iteratorVarName: string = '';
    public sizeVarName: string = '';
    public startVarName: string = '';
    public endVarName: string = '';
    public arraySize: CSimpleElementAccess;
    public arrayDataAccess: CArrayDataAccess;
    public startIndexArg: CExpression;
    public endIndexArg: CExpression;
    public simpleSlice: boolean = false;
    public simpleSliceSize: number = 0;
    public simpleSliceStart: number = 0;
    constructor(scope: IScope, call: ts.CallExpression) {
        super();
        this.topExpressionOfStatement = call.parent.kind == ts.SyntaxKind.ExpressionStatement;
        if (this.topExpressionOfStatement)
            return;

        let propAccess = <ts.PropertyAccessExpression>call.expression;
        let varType = <ArrayType>scope.root.typeHelper.getCType(propAccess.expression);
        let varAccess = new CElementAccess(scope, propAccess.expression);
        this.arraySize = new CSimpleElementAccess(scope, varType, varAccess, "length");
        this.arrayDataAccess = new CArrayDataAccess(scope, varAccess, varType.isDynamicArray);

        this.iteratorVarName = scope.root.symbolsHelper.addIterator(propAccess);
        scope.variables.push(new CVariable(scope, this.iteratorVarName, NumberVarType));

        let args = call.arguments.map(a => CodeTemplateFactory.createForNode(scope, a));
        this.startIndexArg = args[0];
        this.endIndexArg = args.length == 2 ? args[1] : null;

        let { start, size, dynamic } = getSliceParams(scope.root.typeHelper, call);
        if (!dynamic) {
            this.simpleSlice = true;
            this.simpleSliceStart = start;
            this.simpleSliceSize = size;
            const reuseVariable = tryReuseExistingVariable(call);
            if (reuseVariable)
                this.tempVarName = reuseVariable.getText();
            else {
                this.tempVarName = scope.root.symbolsHelper.addTemp(propAccess, "tmp_slice");
                scope.variables.push(new CVariable(scope, this.tempVarName, new ArrayType(varType.elementType, this.simpleSliceSize, false)));
            }
            return;
        }        
       
        this.tempVarName = scope.root.memoryManager.getReservedTemporaryVarName(call);
        let arrayType = <ArrayType>scope.root.typeHelper.getCType(propAccess.expression);
        let tempVarType = new ArrayType(arrayType.elementType, 0, true);
        if (!scope.root.memoryManager.variableWasReused(call))
            scope.variables.push(new CVariable(scope, this.tempVarName, tempVarType));
        this.sizeVarName = scope.root.symbolsHelper.addTemp(propAccess, this.tempVarName + "_size");
        scope.variables.push(new CVariable(scope, this.sizeVarName, NumberVarType));
        this.startVarName = scope.root.symbolsHelper.addTemp(propAccess, this.tempVarName + "_start");
        scope.variables.push(new CVariable(scope, this.startVarName, NumberVarType));
        if (args.length == 2) {
            this.endVarName = scope.root.symbolsHelper.addTemp(propAccess, this.tempVarName + "_end");
            scope.variables.push(new CVariable(scope, this.endVarName, NumberVarType));
        }
        scope.root.headerFlags.array = true;
    }

}

@CodeTemplate(`
{#if isDynamicArray}
    {elementAccess}->data
{#else}
    {elementAccess}
{/if}`)
class CArrayDataAccess {
    constructor(scope: IScope, public elementAccess: CElementAccess, public isDynamicArray: boolean) {}
}

function getSliceParams(typeHelper: TypeHelper, call: ts.CallExpression) {
    let params = { start: 0, size: 0, dynamic: true, elementType: null };
    if (!ts.isPropertyAccessExpression(call.expression))
        return params;
    let objType = typeHelper.getCType(call.expression.expression);
    if (!(objType instanceof ArrayType))
        return params;
    params.elementType = objType.elementType;
    let reuseVar = tryReuseExistingVariable(call);
    let reuseVarType = reuseVar && typeHelper.getCType(reuseVar);
    let reuseVarIsDynamicArray = reuseVar && reuseVarType instanceof ArrayType && reuseVarType.isDynamicArray;
    let isSimpleSlice = !reuseVarIsDynamicArray && !objType.isDynamicArray && call.arguments.every(a => ts.isNumericLiteral(a) || ts.isPrefixUnaryExpression(a) && a.operator == ts.SyntaxKind.MinusToken && ts.isNumericLiteral(a.operand));
    if (isSimpleSlice) {
        let arraySize = objType.capacity;
        let startIndexArg = +call.arguments[0].getText();
        if (call.arguments.length == 1) {
            params.start = startIndexArg < 0 ? arraySize + startIndexArg : startIndexArg;
            params.size = startIndexArg < 0 ? -startIndexArg : arraySize - startIndexArg;
        } else {
            let endIndexArg = +call.arguments[1].getText();
            params.start = startIndexArg < 0 ? arraySize + startIndexArg : startIndexArg;
            params.size = (endIndexArg < 0 ? arraySize + endIndexArg : endIndexArg) - params.start;
        }
        params.dynamic = params.size <= 0; // C standard doesn't allow creating static arrays with zero size, so we have to go with a dynamic array if size is 0
    }
    return params;
}

function tryReuseExistingVariable(node: ts.Node) {
    if (node.parent.kind == ts.SyntaxKind.BinaryExpression) {
        let assignment = <ts.BinaryExpression>node.parent;
        if (assignment.left.kind == ts.SyntaxKind.Identifier)
            return assignment.left;
    }
    if (node.parent.kind == ts.SyntaxKind.VariableDeclaration) {
        let assignment = <ts.VariableDeclaration>node.parent;
        if (assignment.name.kind == ts.SyntaxKind.Identifier)
            return assignment.name;
    }
    return null;
}
