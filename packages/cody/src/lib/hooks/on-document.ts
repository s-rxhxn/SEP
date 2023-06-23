import {CodyHook, Node} from "@proophboard/cody-types";
import {Context} from "./context";
import {asyncWithErrorCheck, CodyResponseException, withErrorCheck} from "./utils/error-handling";
import {names} from "@event-engine/messaging/helpers";
import {getVoMetadata} from "./utils/value-object/get-vo-metadata";
import {flushChanges, FsTree} from "nx/src/generators/tree";
import {generateFiles} from "@nx/devkit";
import {
  namespaceNames,
  valueObjectNamespaceFromFQCN
} from "./utils/value-object/namespace";
import {voPath} from "./utils/value-object/vo-path";
import {detectDescriptionType, isQueryableStateListDescription} from "@event-engine/descriptions/descriptions";
import {detectService} from "./utils/detect-service";
import {updateProophBoardInfo} from "./utils/prooph-board-info";
import {toJSON} from "./utils/to-json";
import {convertRuleConfigToValueObjectInitializeRules} from "./utils/rule-engine/convert-rule-config-to-behavior";
import {register, registerQuery, registerQueryResolver, registerValueObjectDefinition} from "./utils/registry";
import {listChangesForCodyResponse} from "./utils/fs-tree";
import {makeQueryResolver} from "./utils/query/make-query-resolver";
import {voClassNameFromFQCN} from "./utils/value-object/definitions";
import {upsertListViewComponent} from "./utils/ui/upsert-list-view-component";
import {upsertStateViewComponent} from "./utils/ui/upsert-state-view-component";

export const onDocument: CodyHook<Context> = async (vo: Node, ctx: Context) => {
  try {
    const voNames = names(vo.getName());
    const voMeta = withErrorCheck(getVoMetadata, [vo, ctx]);
    const service = withErrorCheck(detectService, [vo, ctx]);
    const serviceNames = names(service);
    let queryNames;

    if(voMeta.isQueryable) {
      queryNames = names('Get' + voNames.className);
    }

    const tree = new FsTree(ctx.projectRoot, true);

    const ns = namespaceNames(voMeta.ns);

    // Register Value Object

    let initializeRules = '';

    if(voMeta.initialize) {
      initializeRules = withErrorCheck(convertRuleConfigToValueObjectInitializeRules, [vo, ctx, voMeta.initialize]);
    }

    generateFiles(tree, __dirname + '/vo-files/shared/types', withErrorCheck(voPath, [vo, voMeta, ctx]), {
      tmpl: "",
      "descriptionType": detectDescriptionType(voMeta),
      ...voNames,
      serviceNames,
      meta: voMeta,
      queryNames,
      ns,
      toJSON,
      initializeRules,
      ...withErrorCheck(updateProophBoardInfo, [vo, ctx, tree])
    });

    withErrorCheck(register, [vo, ctx, tree]);
    withErrorCheck(registerValueObjectDefinition, [service, vo, voMeta, ctx, tree]);

    // Register Query if VO is queryable

    if(voMeta.isQueryable) {
      generateFiles(tree, __dirname + '/query-files/shared', ctx.sharedSrc, {
        tmpl: "",
        service: serviceNames.fileName,
        serviceNames,
        voNames,
        ns,
        schema: voMeta.querySchema,
        toJSON,
        ...queryNames,
        ...withErrorCheck(updateProophBoardInfo, [vo, ctx, tree])
      });

      withErrorCheck(registerQuery, [service, vo, voMeta, ctx, tree]);

      let itemNames, itemNS, isList = false;

      if(isQueryableStateListDescription(voMeta)) {
        itemNames = names(voClassNameFromFQCN(voMeta.itemType));
        itemNS = namespaceNames(valueObjectNamespaceFromFQCN(voMeta.itemType));
        isList = true;
      }

      generateFiles(tree, __dirname + '/query-files/be', ctx.beSrc, {
        tmpl: "",
        service: serviceNames.fileName,
        serviceNames,
        voNames,
        ns,
        isList,
        itemNames,
        itemNS,
        ...queryNames,
        resolve: withErrorCheck(makeQueryResolver, [vo, voMeta, ctx])
      });

      withErrorCheck(registerQueryResolver, [service, vo, ctx, tree]);

      // Upsert View Component
      if(isList) {
        await asyncWithErrorCheck(upsertListViewComponent, [vo, voMeta, ctx, tree]);
      } else {
        await asyncWithErrorCheck(upsertStateViewComponent, [vo, voMeta, ctx, tree]);
      }
    }

    const changes = tree.listChanges();

    flushChanges(ctx.projectRoot, changes);

    return {
      cody: `The data type (value object) "${vo.getName()}" is added to the app.`,
      details: `You can reference the data type in commands, events, queries and other data type using "${voMeta.ns}${voNames.className}".\n\n`
                + listChangesForCodyResponse(tree)
    }
  } catch (e) {
    if(e instanceof CodyResponseException) {
      return e.codyResponse;
    }

    throw e;
  }
}
