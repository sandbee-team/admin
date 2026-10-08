import { ArrowRight } from "lucide-react";
import { Link } from "../lib/router";
import { Badge } from "./ui";
import { ProductIcon } from "./product-icon";
import { modelFor } from "../../../shared/product-models";
export function ProductCatalog({ rows }) {
  const groups = Map.groupBy(rows, (product) => product.category);
  return (
    <div className="catalog-groups">
      {[...groups]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([category, products]) => (
          <section key={category}>
            <div className="catalog-group-title">
              <h2>{category}</h2>
              <span>
                {products.length}{" "}
                {products.length === 1 ? "product" : "products"} on this page
              </span>
            </div>
            <div className="product-grid">
              {products.map((product) => (
                <Link
                  href={`/products/${product._id}`}
                  className="product-card"
                  key={product._id}
                >
                  <div className="product-card-head">
                    <span className="product-symbol">
                      <ProductIcon product={product} />
                    </span>
                    <Badge value={product.status} />
                  </div>
                  <h3>{product.name}</h3>
                  <p>{product.description}</p>
                  <div className="product-meta">
                    <span>{modelFor(product).label}</span>
                    <Badge value={product.pricing} />
                  </div>
                  <div className="product-card-foot">
                    Open product
                    <ArrowRight size={15} />
                  </div>
                </Link>
              ))}
            </div>
          </section>
        ))}
    </div>
  );
}
