from databricks import sql
from app.config import DATABRICKS_SERVER_HOSTNAME, DATABRICKS_HTTP_PATH, DATABRICKS_TOKEN

def test_connection():
    with sql.connect(
        server_hostname=DATABRICKS_SERVER_HOSTNAME,
        http_path=DATABRICKS_HTTP_PATH,
        access_token=DATABRICKS_TOKEN
    ) as connection:

        with connection.cursor() as cursor:
            cursor.execute("""
                SELECT COUNT(*)
                FROM workspace.data_quality_rules.orders
            """)

            result = cursor.fetchone()
            print(f"Orders count: {result[0]}")


if __name__ == "__main__":
    test_connection()