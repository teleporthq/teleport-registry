import express from "express";
import { build } from "esbuild";
import esbuildCssModules from "esbuild-css-modules-plugin";
import { GoogleCloud } from "./cloud";
import { Generator } from "./generator";
import { camelCaseToDashCase } from "./constants";
import {
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  rmdirSync,
} from "fs";
import { ComponentUIDL, FileType } from "@teleporthq/teleport-types";
import { Parser } from "@teleporthq/teleport-uidl-validator";
import { join } from "path";
import { v4 } from "uuid";
import { tmpdir } from "os";

const generator = new Generator();
const cloud = new GoogleCloud();
const port = process.env.PORT || 8080;
const app = express();

app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  next();
});

app.post("/build-package", async (req, res) => {
  const { components, entry, designLanguage, styleSetDefinitions } =
    req.body || {
      styleSetDefinitions: {},
      designLanguage: {},
      entry: null,
      components: [],
    };

  if (!entry) {
    res.status(400).json({ error: "Entry file is missing" });
    return;
  }

  if (components.length === 0) {
    res.status(400).json({ error: "No components received" });
    return;
  }

  const buildPath =
    process.env.NODE_ENV === "development"
      ? join(__dirname, "../build")
      : join(tmpdir(), "build");
  const entryPath = `${join(buildPath, camelCaseToDashCase(entry))}.jsx`;
  const outfile = join(buildPath, "bundle.js");
  const external: string[] = ["react", "react-dom", "react-router-dom"];

  if (!existsSync(buildPath)) {
    mkdirSync(buildPath);
  }

  /* Generating gloal style sheet */
  const rootUIDL: ComponentUIDL = {
    name: "root",
    designLanguage,
    styleSetDefinitions,
    stateDefinitions: {},
    propDefinitions: {},
    node: {
      type: "element",
      content: {
        elementType: "container",
      },
    },
  };
  const parsedComponentUIDL = Parser.parseComponentJSON(
    rootUIDL as unknown as Record<string, unknown>
  );

  if (
    Object.keys(styleSetDefinitions || {}).length > 0 ||
    Object.keys(designLanguage?.tokens || {}).length > 0
  ) {
    try {
      const { files, dependencies } =
        await generator.styleSheet.generateComponent(rootUIDL, {
          isRootComponent: true,
        });
      writeFileSync(
        join(buildPath, `${files[0].name}.${files[0].fileType}`),
        files[0].content,
        "utf-8"
      );
      external.push(...Object.keys(dependencies));
    } catch (e) {
      console.trace(e);
      res
        .status(500)
        .json({ error: "Failed in generating global style sheet" });
      return;
    }
  }

  /* Generating components */
  try {
    for (const comp of components) {
      const { files, dependencies } = await generator.component(comp, {
        projectStyleSet: {
          styleSetDefinitions: parsedComponentUIDL.styleSetDefinitions,
          fileName: "style",
          path: "./",
          importFile: true,
        },
        designLanguage: parsedComponentUIDL.designLanguage,
      });

      files.forEach((file) => {
        const base = join(buildPath, file.name);
        external.push(...Object.keys(dependencies));
        writeFileSync(
          `${base}.${file.fileType === FileType.JS ? "jsx" : file.fileType}`,
          file.content,
          "utf-8"
        );
      });
    }

    await build({
      bundle: true,
      plugins: [esbuildCssModules({ localsConvention: "dashes" })],
      entryPoints: [entryPath],
      outfile,
      format: "esm",
      jsx: "transform",
      jsxFragment: "Fragment",
      minifyWhitespace: process.env.NODE_ENV === "development" ? false : true,
      target: ["es2016"],
      platform: "browser",
      external,
    });

    const packageId = `${camelCaseToDashCase(entry)}_${v4()}.js`;
    await cloud.uploadPackage(readFileSync(outfile), packageId);
    rmdirSync(buildPath, { recursive: true });

    res
      .status(200)
      .json({ id: packageId, url: `https://jscdn.teleporthq.io/${packageId}` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed in generating component" });
    return;
  }
});

app.get("/", (req, res) => res.send("Package Server"));

if (process.env.NODE_ENV !== "production") {
  app.listen(port, () => {
    console.log(`Server running on ${port}`);
  });
}

export { app };
