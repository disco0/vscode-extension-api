"use strict";
import * as vscode from "vscode";
import * as power from "node-power-info";

export function activate(context: vscode.ExtensionContext) {
    let extensionAPI = new ExtensionAPI();
    context.subscriptions.push(extensionAPI);
    context.subscriptions.push(new ExtensionAPIController(extensionAPI));
}

class ExtensionAPIController {
    private extensionAPI: ExtensionAPI;
    private disposable: vscode.Disposable;
    private lastLine: number = undefined;

    constructor(extensionAPI: ExtensionAPI){
        this.extensionAPI = extensionAPI;

        let subscriptions: vscode.Disposable[] = [];
        subscriptions.push(vscode.commands.registerCommand(
            "extension-api.pickExpression", () => {
                this.extensionAPI.pickExpression();
            }
        ));
        subscriptions.push(vscode.commands.registerCommand(
            "extension-api.evaluate", () => {
                this.extensionAPI.evaluate();
            }
        ));
        subscriptions.push(vscode.commands.registerCommand(
            "extension-api.runSelection", () => {
                this.extensionAPI.runSelection();
            }
        ));
        subscriptions.push(vscode.commands.registerCommand(
            "extension-api.runFile", () => {
                this.extensionAPI.runFile();
            }
        ));
        vscode.workspace.onDidChangeConfiguration(() => {
            this.extensionAPI.updateConfigurations();
        }, this, subscriptions);

        this.disposable = vscode.Disposable.from(...subscriptions);
    }

    dispose(){
        this.disposable.dispose();
    }
}

interface ActionItem extends vscode.MessageItem {
    identifier: string;
}

class ExtensionAPI {
    outputChanel: vscode.OutputChannel;
    statusItem: vscode.StatusBarItem;
    includePrototype = false;
    includePrivate = true;
    pretty = false;
    statusUpdater: NodeJS.Timer | undefined;

    constructor(){
        this.statusItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right
        );
        this.statusItem.command = "extension-api.pickExpression";
        this.statusItem.text = "$(plug)";
        this.statusItem.tooltip = "Pick Visual Studio Code's Extension API";
        this.updateConfigurations();
    }

    dispose(){
        this.outputChanel.dispose();
        this.statusItem.dispose();
    }

    updateConfigurations(){
        let configurations = vscode.workspace.getConfiguration("extension-api");
        this.includePrototype = configurations.get<boolean>("includePrototype");
        this.includePrivate = configurations.get<boolean>("includePrivate");
        this.pretty = configurations.get<boolean>("pretty");
        if (this.statusUpdater) {
            clearInterval(this.statusUpdater);
        }
        if(configurations.get<boolean>("showAPIShortcut")){
            if (configurations.get<boolean>("useAsBatteryIndicator")) {
                this.updateEasterEgg();
                setInterval(this.updateEasterEgg.bind(this), 60000);
            }
            this.statusItem.show();
        }else{
            this.statusItem.hide();
        }
    }

    getType(object: any): string {
        if(typeof(object) === "object" && Array.isArray(object)){
            return `object:array(${object.length})`;
        }
        return typeof(object);
    }

    pickExpression(object: any = vscode, name: string = "vscode"){
        let components = name.split(".");
        let items = Object.getOwnPropertyNames(object).concat(
            Object.getOwnPropertyNames(Object.getPrototypeOf(object)
        )).filter(value => {
            if(value.startsWith("__")){
                return this.includePrototype;
            }
            if(value.startsWith("_")){
                return this.includePrivate;
            }
            return true;
        }).map(value => {
            let isArray = Array.isArray(object) && value.match("\\d+");
            return {
                label: (
                    isArray ?
                    `${components[components.length - 1]}[${value}]` :
                    value
                ),
                description: this.getType(object[value]),
                identifier: isArray ? `[${value}]` :`.${value}`,
                value: object[value]
            };
        });
        vscode.window.showQuickPick(
            [{
                label: "this",
                description: components[components.length - 1],
                identifier: "",
                value: object
            }].concat(
                items.filter(item => {
                    return item.description !== "undefined";
                }).sort((a, b) => {
                    let compare = 0;
                    if(
                        a.description === "function" &&
                        b.description === "function"
                    ){
                        compare = 0;
                    }else if(a.description === "function"){
                        return -1;
                    }else if(b.description === "function"){
                        return 1;
                    }
                    if(compare === 0){
                        compare = a.label.localeCompare(b.label);
                    }
                    return compare;
                })
            ), {
                placeHolder: name
            }
        ).then(item => {
            if(!item){
                return;
            }
            if(
                item.description.split(":")[0] === "object" &&
                item.identifier !== ""
            ){
                this.pickExpression(item.value, `${name}${item.identifier}`);
            }else{
                this.evaluate(`${name}${item.identifier}`);
            }
        });
    }

    evaluate(value: string = "vscode.window.activeTextEditor"){
        vscode.window.showInputBox({
            placeHolder: "Insert Visual Studio Code's API Call Here...",
            value: value,
            prompt: "Visual Studio Code's API Calls"
        }).then(value => {
            if(!value){
                return;
            }
            this.evaluateExpression(value);
        })
    }

    runSelection() {
        let editor = vscode.window.activeTextEditor;
        let selection = editor.selection;
        if (!selection.isEmpty) {
            this.evaluateExpression(editor.document.getText(selection));
        }
    }

    runFile() {
        let editor = vscode.window.activeTextEditor;
        let text = editor.document.getText();
        this.evaluateExpression(text);
    }


    actionHandler(expression: string) {
        return (item) => {
            if(!item){
                return;
            }
            if(item.identifier === "reevaluate"){
                this.evaluateExpression(expression);
            }else if(item.identifier === "show"){
                this.outputChanel.show();
            }
        }
    };

    private resolveExpression(expression: string, output: string) {
        vscode.window.showInformationMessage(
            output, {
                title: "Re-Evaluate",
                identifier: "reevaluate"
            }, {
                title: "Show Full Output",
                identifier: "show"
            }
        ).then(this.actionHandler(expression));
    }

    private determinePromise(expression: string, promise: any) {
        if (
            typeof(promise) === "object" &&
            !Array.isArray(promise) &&
            promise.then &&
            typeof(promise.then) === "function"
        ) {
            let thenPromise = promise.then(
                (output) => this.determineOutput(expression, output)
            );
            if (
                typeof(thenPromise) === "object" &&
                !Array.isArray(thenPromise) &&
                thenPromise.catch &&
                typeof(thenPromise.catch) === "function"
            ) {
                thenPromise.catch(
                    (error) => this.rejectExpression(expression, error)
                );
            }

            return true;
        }

        return false;
    }

    private rejectExpression(expression: string, error: Error) {
        vscode.window.showErrorMessage(`Error: ${ error }`, {
            title: "Show Full Output",
            identifier: "show"
        }).then(this.actionHandler(expression));
    }

    private determineOutput(expression: string, output: any) {
        if(!this.outputChanel){
            this.outputChanel = vscode.window.createOutputChannel(
                "Extension API"
            );
        }

        if (this.determinePromise(expression, output)) {
            return;
        }

        if(typeof(output) === "object"){
            output = JSON.stringify(
                output, undefined, this.pretty ? 2 : undefined
            );
        }else if(output === undefined || output === null){
            output = typeof(output);
        }else{
            output = `${ output }`;
        }

        this.outputChanel.appendLine(`Expression: ${ expression }`);
        this.outputChanel.appendLine(`Output: ${ output }`);

        this.resolveExpression(expression, output)
    }

    evaluateExpression(expression: string){
        if (this.outputChanel) {
            this.outputChanel.clear();
        }
        try {
            this.determineOutput(expression, eval(expression))
        } catch (error) {
            this.rejectExpression(expression, error);
        }
    }

    updateEasterEgg(){
        this.statusItem.text = "$(plug)";
        power.getDefault().then(
            (provider) => provider.getBatteries()
        ).then((batteries) => {
            if (batteries.length <= 0) {
                return;
            }
            let battery = batteries[0];

            if (battery.chargeStatus === "discharging") {
                this.statusItem.text = "$(database)";
            } else if (battery.chargeStatus === "charging") {
                this.statusItem.text = "$(zap)";
            }

            let status = `Pick Visual Studio Code's Extension API\n\nBattery: ${
                battery.powerLevel
            }% (${
                battery.chargeStatus
            })`;

            if (battery.isTimeAvailable) {
                let remainingMinutes = (
                    "0" + battery.remainingTimeMinutes
                ).slice(-2);
                status += `\nTime Remaining: ${
                    battery.remainingTimeHours
                }:${
                    remainingMinutes
                }`;
            }

            this.statusItem.tooltip = status;
        });
    }
}
